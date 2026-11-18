import { parseArgs } from 'node:util';
import { assertUsernameAvailable, DomainError, parseUsername, type User, type UserRepository } from '@factory/core';
import { SqliteAccessTokenRepository } from './adapters/sqlite-access-token-repository.ts';
import { SqliteSessionRepository } from './adapters/sqlite-session-repository.ts';
import { SqliteUserRepository } from './adapters/sqlite-user-repository.ts';
import { AccessTokenService } from './auth/access-token-service.ts';
import { parsePassword, ScryptPasswordHasher } from './auth/passwords.ts';
import { UserAccountService } from './user-account-service.ts';

export const usage = `Usage: yarn user <command>

Commands:
  add <username> [--display-name <name>]  Create a user and set its password
  list                                    List all users
  passwd <username>                       Set a user's password
  rename <username> <display name...>     Change a user's display name
  disable <username>                      Disable a user for good, end its sessions and revoke its tokens
  token <username> <name...> [--expires-in-days <n>]
                                          Create a personal access token and print it once

Passwords are read from the terminal, or from the first line of stdin when it is piped.
A token (fct_...) acts as its user on the engineer API and /mcp via "Authorization: Bearer <token>";
it never expires unless --expires-in-days is given.
The database is FACTORY_DB (default factory.db).`;

export class UsageError extends Error {
  override name = 'UsageError';
}

export interface UserCliDeps {
  /** Looks users up by username and lists them. */
  users: UserRepository;
  accounts: UserAccountService;
  accessTokens: AccessTokenService;
  /** Reads a new password, confirmed when entered interactively. */
  readPassword: () => Promise<string>;
  stdout: { write(text: string): unknown };
}

/** Runs one CLI command; throws on errors, a `UsageError` for bad invocations. */
export async function runUserCli(argv: readonly string[], deps: UserCliDeps): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        'display-name': { type: 'string' },
        'expires-in-days': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n\n${usage}`);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    deps.stdout.write(`${usage}\n`);
    return;
  }
  const [command, ...args] = positionals;
  if (values['display-name'] !== undefined && command !== 'add') {
    throw new UsageError(`--display-name is only valid for add\n\n${usage}`);
  }
  if (values['expires-in-days'] !== undefined && command !== 'token') {
    throw new UsageError(`--expires-in-days is only valid for token\n\n${usage}`);
  }
  const expect = (count: number, atLeast = false): void => {
    if (atLeast ? args.length < count : args.length !== count) {
      throw new UsageError(`wrong number of arguments for ${command}\n\n${usage}`);
    }
  };

  switch (command) {
    case 'add': {
      expect(1);
      const username = parseUsername(args[0]!);
      // Checked before asking for the password too, so it is not typed for a taken name.
      assertUsernameAvailable(username, deps.users.getByUsername(username));
      const user = await deps.accounts.create({ username, displayName: values['display-name'] }, await deps.readPassword());
      deps.stdout.write(`created user ${user.username}\n`);
      return;
    }
    case 'list': {
      expect(0);
      deps.stdout.write(formatUsers(deps.users.list()));
      return;
    }
    case 'passwd': {
      expect(1);
      const user = findUser(deps.users, args[0]!);
      await deps.accounts.setPassword(user.id, await deps.readPassword());
      deps.stdout.write(`password set for ${user.username}\n`);
      return;
    }
    case 'rename': {
      expect(2, true);
      const renamed = deps.accounts.rename(findUser(deps.users, args[0]!).id, args.slice(1).join(' '));
      deps.stdout.write(`renamed ${renamed.username} to ${renamed.displayName}\n`);
      return;
    }
    case 'disable': {
      expect(1);
      const user = findUser(deps.users, args[0]!);
      const wasActive = deps.accounts.disable(user.id);
      deps.stdout.write(wasActive ? `disabled ${user.username}\n` : `${user.username} is already disabled\n`);
      return;
    }
    case 'token': {
      expect(2, true);
      const days = values['expires-in-days'];
      // All digits, so `1.5` or `7d` are rejected rather than read as 1 or 7; the service checks the range.
      if (days !== undefined && !/^\d+$/.test(days)) {
        throw new UsageError(`--expires-in-days must be a whole number of days\n\n${usage}`);
      }
      const user = findUser(deps.users, args[0]!);
      const { token } = deps.accessTokens.issue(user.id, {
        name: args.slice(1).join(' '),
        ...(days !== undefined && { expiresInDays: Number(days) }),
      });
      // The token alone, so `TOKEN=$(yarn user token alice laptop)` works; it is not shown again.
      deps.stdout.write(`${token}\n`);
      return;
    }
    case undefined:
      throw new UsageError(usage);
    default:
      throw new UsageError(`unknown command: ${command}\n\n${usage}`);
  }
}

function findUser(users: UserRepository, username: string): User {
  const user = users.getByUsername(username);
  if (user === undefined) throw new DomainError('unknown_user', `user ${username} does not exist`);
  return user;
}

export function formatUsers(users: readonly User[]): string {
  if (users.length === 0) return 'no users\n';
  const rows = [
    ['USERNAME', 'DISPLAY NAME', 'STATUS', 'CREATED'],
    ...users.map((user) => [
      user.username,
      user.displayName,
      user.disabledAt === undefined ? 'active' : 'disabled',
      user.createdAt,
    ]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows
    .map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd())
    .join('\n')
    .concat('\n');
}

/** Reads a password from the terminal without echo, twice; Ctrl-C aborts. */
async function promptPassword(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let password = '';
      const onData = (chunk: string): void => {
        for (const char of chunk) {
          if (char === '\r' || char === '\n' || (char === '\u0004' && password === '')) {
            stdin.off('data', onData);
            resolve(password);
            return;
          }
          if (char === '\u0003') {
            stdin.off('data', onData);
            reject(new Error('aborted'));
            return;
          }
          if (char === '\u007f' || char === '\b') {
            password = [...password].slice(0, -1).join('');
          } else if (char >= ' ') {
            password += char;
          }
        }
      };
      stdin.on('data', onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    process.stderr.write('\n');
  }
}

async function readTtyPassword(): Promise<string> {
  const password = await promptPassword('Password: ');
  // Check the policy before the confirmation, so a too short password is not typed twice.
  parsePassword(password);
  if ((await promptPassword('Repeat password: ')) !== password) throw new Error('passwords do not match');
  return password;
}

/** The first line of piped stdin, without its line ending. */
async function readPipedPassword(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin.setEncoding('utf8')) {
    text += chunk as string;
    if (text.includes('\n')) break;
  }
  const newline = text.indexOf('\n');
  const line = newline === -1 ? text : text.slice(0, newline);
  if (newline === -1 && line === '') throw new Error('no password on stdin');
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

async function main(): Promise<void> {
  const dbPath = process.env.FACTORY_DB ?? 'factory.db';
  const users = new SqliteUserRepository(dbPath);
  const sessions = new SqliteSessionRepository(dbPath);
  const tokens = new SqliteAccessTokenRepository(dbPath);
  try {
    await runUserCli(process.argv.slice(2), {
      users,
      accounts: new UserAccountService({ users, passwords: users, hasher: new ScryptPasswordHasher(), sessions, tokens }),
      accessTokens: new AccessTokenService({ tokens, users }),
      readPassword: process.stdin.isTTY ? readTtyPassword : readPipedPassword,
      stdout: process.stdout,
    });
  } finally {
    users.close();
    sessions.close();
    tokens.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
