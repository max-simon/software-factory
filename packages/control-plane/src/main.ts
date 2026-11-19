import { fileURLToPath } from 'node:url';
import { createApiClient, createMcpHandler } from '@factory/mcp';
import { ConfigError, loadConfig, unavailableAgent } from './config.ts';
import { GitHubIssues } from './adapters/github-issues.ts';
import { GitHubPullRequests } from './adapters/github-pull-requests.ts';
import { PodmanRuntime } from './adapters/podman-runtime.ts';
import { PodmanReviewer } from './adapters/podman-reviewer.ts';
import { SqliteAccessTokenRepository } from './adapters/sqlite-access-token-repository.ts';
import { SqliteSessionRepository } from './adapters/sqlite-session-repository.ts';
import { SqliteProjectRepository } from './adapters/sqlite-project-repository.ts';
import { SqliteTaskRepository } from './adapters/sqlite-task-repository.ts';
import { SqliteUserRepository } from './adapters/sqlite-user-repository.ts';
import { AccessTokenService } from './auth/access-token-service.ts';
import { LocalPasswordAuthenticator } from './auth/local-password-authenticator.ts';
import { LoginThrottle } from './auth/login-throttle.ts';
import { ScryptPasswordHasher } from './auth/passwords.ts';
import { SessionService } from './auth/session-service.ts';
import { Dispatcher } from './dispatcher.ts';
import { Hooks } from './hooks/hooks.ts';
import { InputReviewHook } from './hooks/input-review-hook.ts';
import { PrReviewHook } from './hooks/pr-review-hook.ts';
import { PullRequestConflictedHook } from './hooks/pull-request-conflicted-hook.ts';
import { PullRequestReviewedHook } from './hooks/pull-request-reviewed-hook.ts';
import { SpecReviewHook } from './hooks/spec-review-hook.ts';
import { agentRoutes } from './http/agent-routes.ts';
import { authRoutes } from './http/auth-routes.ts';
import { authenticateRequest } from './http/authenticate.ts';
import { engineerRoutes } from './http/engineer-routes.ts';
import { createServer, mcpPath } from './http/server.ts';
import { staticFiles } from './http/static-files.ts';
import { tokenRoutes } from './http/token-routes.ts';
import { IssueSync, issueSyncIntervalMs } from './issue-sync-service.ts';
import { PauseWatch } from './pause-watch.ts';
import { ProjectService } from './project-service.ts';
import { PullRequestObserver, pullRequestPollIntervalMs } from './pull-request-observer.ts';
import { ReviewTracker } from './review-tracker.ts';
import { createServices } from './services.ts';
import { UserAccountService } from './user-account-service.ts';

// Engineers sign in, but the API is not hardened for other machines yet (plain HTTP, no TLS), so it stays on loopback.
const host = '127.0.0.1';
const reconcileIntervalMs = 2000;
// Far above the 5 failures that lock a username: on loopback every client shares one address.
const clientLockoutAfter = 50;
const pauseCheckIntervalMs = 1000;
// Built by `yarn web:build`; without it the control plane serves the API only.
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));

// Each pass is scheduled only after the previous one finished, so passes never overlap.
// The first pass runs immediately, which recovers state after a control-plane restart.
function runLoop(name: string, pass: () => Promise<void>, intervalMs: number): void {
  void pass()
    .catch((error: unknown) => console.error(`${name} pass failed:`, error))
    .finally(() => setTimeout(() => runLoop(name, pass, intervalMs), intervalMs));
}

function main(): void {
  const config = loadConfig();
  const repository = new SqliteTaskRepository(config.dbPath);
  const runtime = new PodmanRuntime({
    image: config.image,
    gitUserName: config.gitUserName,
    gitUserEmail: config.gitUserEmail,
    agentCredentials: config.agentCredentials,
  });
  const users = new SqliteUserRepository(config.dbPath);
  // Hooks need the services, which publish to the hooks, so they are registered once the services exist.
  const hooks = new Hooks();
  const secrets = [...config.credentials.map((name) => process.env[name]!), process.env.GITHUB_TOKEN!];
  const issues =
    config.githubIssueRepos.length > 0
      ? new GitHubIssues({ token: process.env.GITHUB_TOKEN!, repos: config.githubIssueRepos, dbPath: config.dbPath })
      : undefined;
  const { tasks, service, agent, lifecycle } = createServices({
    repository,
    runtime,
    users,
    issues,
    secrets,
    onEvent: (event) => void hooks.emit(event),
  });
  const projectRepository = new SqliteProjectRepository(config.dbPath);
  const projects = new ProjectService({ repository: projectRepository });
  // One image, three roles: it reviews task specifications, the input agents ask for, and pull requests.
  const reviewer = new PodmanReviewer({
    image: config.reviewerImage,
    model: config.reviewerModel,
    // It runs the claude CLI, so it gets what a claude task gets; claude takes either credential, so it always has one.
    anthropicCredential: config.agentCredentials.claude!,
  });
  const pullRequests = new GitHubPullRequests(process.env.GITHUB_TOKEN!);
  // The hooks record the reviews they run; the engineer API shows them.
  const reviews = new ReviewTracker();
  hooks.register(new SpecReviewHook({ tasks, service, projects, reviewer, reviews }));
  hooks.register(new InputReviewHook({ tasks, service, projects, reviewer, reviews }));
  hooks.register(new PrReviewHook({ tasks, pullRequests, reviewer, projects, reviews }));
  hooks.register(new PullRequestReviewedHook({ lifecycle }));
  hooks.register(new PullRequestConflictedHook({ lifecycle }));
  const sessionStore = new SqliteSessionRepository(config.dbPath);
  const sessions = new SessionService({
    sessions: sessionStore,
    users,
    idleTimeoutMs: config.sessionIdleHours * 3_600_000,
    maxLifetimeMs: config.sessionMaxDays * 86_400_000,
  });
  const tokenStore = new SqliteAccessTokenRepository(config.dbPath);
  const accessTokens = new AccessTokenService({ tokens: tokenStore, users });
  const hasher = new ScryptPasswordHasher();
  const routes = [
    ...authRoutes({
      authenticator: new LocalPasswordAuthenticator({ users, passwords: users, hasher }),
      sessions,
      accounts: new UserAccountService({ users, passwords: users, hasher, sessions: sessionStore, tokens: tokenStore }),
      users,
      throttle: new LoginThrottle(),
      clientThrottle: new LoginThrottle({ lockoutAfter: clientLockoutAfter }),
    }),
    ...tokenRoutes(accessTokens),
    ...engineerRoutes(tasks, service, projects, (agent) => unavailableAgent(config.agentCredentials, agent), reviews),
    ...agentRoutes(tasks, agent, projects),
  ];
  const server = createServer(routes, {
    authenticate: authenticateRequest(sessions, accessTokens),
    staticFiles: staticFiles(webDist),
    // The MCP tools go through the engineer API over loopback, so they get its validation and error mapping;
    // each request's client passes on the caller's session cookie or bearer token, so the API sees the same user.
    mcp: createMcpHandler((headers) => createApiClient(`http://${host}:${config.port}`, headers)),
  });
  // Checked on a timer of its own: a host may sleep in the middle of a dispatcher pass.
  const pauseWatch = new PauseWatch();
  setInterval(() => pauseWatch.check(), pauseCheckIntervalMs).unref();
  const dispatcher = new Dispatcher({
    tasks,
    lifecycle,
    runtime,
    // Assumes podman forwards this name to the host's loopback; not yet verified
    // against a running podman machine.
    controlPlaneUrl: `http://host.containers.internal:${config.port}`,
    maxRunning: config.maxRunning,
    followUpWindowMs: config.followUpWindowHours * 3_600_000,
    secrets,
    awakeSince: () => pauseWatch.check(),
  });
  // Polls GitHub for pull request changes; replaceable by a webhook that records the same changes.
  const pullRequestObserver = new PullRequestObserver({ tasks, lifecycle, pullRequests, secrets });
  const issueSync = issues && new IssueSync({ tasks, projects: projectRepository, provider: issues, secrets });
  server.listen(config.port, host, () => {
    console.log(`control plane listening on http://${host}:${config.port} (MCP at ${mcpPath})`);
    runLoop('dispatcher', () => dispatcher.reconcile(), reconcileIntervalMs);
    runLoop('pull request observer', () => pullRequestObserver.observe(), pullRequestPollIntervalMs);
    if (issueSync) runLoop('issue sync', () => issueSync.sync(), issueSyncIntervalMs);
  });
}

try {
  main();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`control plane cannot start: ${error.message}`);
  process.exitCode = 1;
}
