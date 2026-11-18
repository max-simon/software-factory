import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, type AccessTokenView } from '../api.ts';
import { ErrorText } from '../components/ErrorText.tsx';
import { useAction, usePolling } from '../hooks.ts';
import { mcpAddCommand, relativeTime, type CurrentUser } from '../model.ts';

const tokenPollIntervalMs = 30_000;
const passwordMinLength = 12;

/** The signed-in user's display name, password and personal access tokens. */
export function Account({ me, onRenamed }: { me: CurrentUser | undefined; onRenamed: (user: CurrentUser) => void }) {
  useEffect(() => {
    document.title = 'Account · Factory';
  }, []);

  if (!me) return <p className="muted">Loading…</p>;
  return (
    <article className="account">
      <header className="task-header">
        <h1>Account</h1>
        <p className="meta">
          <span>{me.username}</span>
          <span className="mono">{me.id}</span>
        </p>
      </header>
      <DisplayNameForm me={me} onRenamed={onRenamed} />
      <PasswordForm />
      <Tokens />
    </article>
  );
}

function DisplayNameForm({ me, onRenamed }: { me: CurrentUser; onRenamed: (user: CurrentUser) => void }) {
  const [displayName, setDisplayName] = useState(me.displayName);
  const [isSaved, setSaved] = useState(false);
  const { isBusy, error, run } = useAction();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(false);
    void run(async () => {
      const renamed = await api.changeDisplayName(displayName);
      setDisplayName(renamed.displayName);
      setSaved(true);
      onRenamed(renamed);
    });
  };
  return (
    <form className="box" onSubmit={submit}>
      <h2 className="section-title">Display name</h2>
      <label className="field">
        <span>Shown on everything you did, past entries included</span>
        <input
          name="displayName"
          value={displayName}
          maxLength={100}
          required
          onChange={(e) => {
            setDisplayName(e.target.value);
            setSaved(false);
          }}
        />
      </label>
      <ErrorText message={error} />
      <div className="actions">
        <button className="button primary" disabled={isBusy || displayName.trim() === '' || displayName.trim() === me.displayName}>
          Save
        </button>
        {isSaved && <span className="muted">Saved.</span>}
      </div>
    </form>
  );
}

function PasswordForm() {
  const [isChanged, setChanged] = useState(false);
  const [mismatch, setMismatch] = useState<string>();
  const { isBusy, error, run } = useAction();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const newPassword = String(form.get('newPassword'));
    setChanged(false);
    if (newPassword !== String(form.get('confirmPassword'))) {
      setMismatch('The new passwords do not match.');
      return;
    }
    setMismatch(undefined);
    void run(async () => {
      await api.changePassword(String(form.get('currentPassword')), newPassword);
      formElement.reset();
      setChanged(true);
    });
  };
  return (
    <form className="box" onSubmit={submit}>
      <h2 className="section-title">Password</h2>
      <label className="field">
        <span>Current password</span>
        <input name="currentPassword" type="password" autoComplete="current-password" required />
      </label>
      <label className="field">
        <span>New password, at least {passwordMinLength} characters</span>
        <input name="newPassword" type="password" autoComplete="new-password" minLength={passwordMinLength} required />
      </label>
      <label className="field">
        <span>Repeat the new password</span>
        <input name="confirmPassword" type="password" autoComplete="new-password" minLength={passwordMinLength} required />
      </label>
      <ErrorText message={mismatch ?? error} />
      <div className="actions">
        <button className="button primary" disabled={isBusy}>
          Change password
        </button>
        {isChanged && <span className="muted">Password changed. Your other sessions are signed out.</span>}
      </div>
    </form>
  );
}

function Tokens() {
  const { data: tokens, error: loadError, reload } = usePolling(api.listTokens, 'tokens', tokenPollIntervalMs);
  const [created, setCreated] = useState<{ id: string; token: string }>();
  const { isBusy, error, run } = useAction();

  const revoke = (token: AccessTokenView) => {
    if (!window.confirm(`Revoke the token “${token.name}”? Clients using it lose access right away.`)) return;
    void run(async () => {
      await api.revokeToken(token.id);
      setCreated((shown) => (shown?.id === token.id ? undefined : shown));
      reload();
    });
  };

  return (
    <section className="box tokens">
      <h2 className="section-title">Personal access tokens</h2>
      <p className="muted">For MCP clients and scripts: a token acts as you on the engineer API and /mcp.</p>
      {created && <NewToken token={created.token}onDismiss={() => setCreated(undefined)} />}
      {!tokens ? (
        <p className="muted">{loadError ? loadError.message : 'Loading…'}</p>
      ) : tokens.length === 0 ? (
        <p className="muted token-empty">No tokens yet.</p>
      ) : (
        <TokenList tokens={tokens} isBusy={isBusy} onRevoke={revoke} />
      )}
      <ErrorText message={error} />
      <CreateTokenForm
        onCreated={(id, token) => {
          setCreated({ id, token });
          reload();
        }}
      />
    </section>
  );
}

const day = (iso: string) => new Date(iso).toLocaleDateString();

export function TokenList({
  tokens,
  isBusy = false,
  onRevoke,
  now = Date.now(),
}: {
  tokens: AccessTokenView[];
  isBusy?: boolean;
  onRevoke: (token: AccessTokenView) => void;
  now?: number;
}) {
  return (
    <ul className="plain token-list">
      {tokens.map((token) => {
        const isExpired = token.expiresAt !== undefined && Date.parse(token.expiresAt) <= now;
        return (
          <li key={token.id}>
            <div className="token-info">
              <span className="token-name">{token.name}</span>
              <span className="meta">
                <span title={token.createdAt}>created {day(token.createdAt)}</span>
                <span title={token.lastUsedAt}>{token.lastUsedAt ? `last used ${relativeTime(token.lastUsedAt, now)}` : 'never used'}</span>
                <span title={token.expiresAt} className={isExpired ? 'failure' : undefined}>
                  {token.expiresAt ? `${isExpired ? 'expired' : 'expires'} ${day(token.expiresAt)}` : 'never expires'}
                </span>
              </span>
            </div>
            <button className="button small danger" disabled={isBusy} onClick={() => onRevoke(token)}>
              Revoke
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function CreateTokenForm({ onCreated }: { onCreated: (id: string, token: string) => void }) {
  const { isBusy, error, run } = useAction();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const days = String(form.get('expiresInDays')).trim();
    void run(async () => {
      const { id, token } = await api.createToken({ name: String(form.get('name')).trim(), ...(days !== '' && { expiresInDays: Number(days) }) });
      formElement.reset();
      onCreated(id, token);
    });
  };
  return (
    <form className="token-form" onSubmit={submit}>
      <h3 className="section-title">New token</h3>
      <div className="token-form-fields">
        <label className="field">
          <span>Name</span>
          <input name="name" maxLength={100} required placeholder="e.g. laptop" />
        </label>
        <label className="field">
          <span>Expires in days (optional)</span>
          <input name="expiresInDays" type="number" min={1} max={3650} step={1} placeholder="never" />
        </label>
      </div>
      <ErrorText message={error} />
      <div className="actions">
        <button className="button primary" disabled={isBusy}>
          Create token
        </button>
      </div>
    </form>
  );
}

/** A token just created: shown this once, with the command that adds the MCP server with it. */
export function NewToken({ token, onDismiss, origin = location.origin }: { token: string; onDismiss: () => void; origin?: string }) {
  const command = mcpAddCommand(origin, token);
  return (
    <div className="new-token" role="status">
      <p>Copy the token now; it is not shown again.</p>
      <Copyable label="Token" text={token} />
      <Copyable label="Add the MCP server to Claude Code" text={command} />
      <div className="actions">
        <button type="button" className="link" onClick={onDismiss}>
          Done
        </button>
      </div>
    </div>
  );
}

function Copyable({ label, text }: { label: ReactNode; text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => setState('copied'),
      () => setState('failed'),
    );
  };
  return (
    <div className="copyable">
      <span className="copyable-label">{label}</span>
      <div className="copyable-row">
        <pre>{text}</pre>
        <button type="button" className="button small" onClick={copy}>
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
