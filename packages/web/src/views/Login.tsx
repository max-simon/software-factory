import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.ts';
import { ErrorText } from '../components/ErrorText.tsx';

/** What a failed login tells the user; the control plane's own words for anything unexpected. */
export function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return 'Wrong username or password.';
  if (error instanceof ApiError && error.status === 429) return 'Too many failed logins. Try again in a little while.';
  return error instanceof Error ? error.message : String(error);
}

/** Signs in with username and password, then returns to `next`. */
export function Login({ next }: { next: string }) {
  const [error, setError] = useState<string>();
  const [isBusy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Sign in · Factory';
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    api.login(String(form.get('username')), String(form.get('password'))).then(
      () => {
        location.hash = next;
      },
      (cause: unknown) => {
        setError(loginErrorMessage(cause));
        setBusy(false);
      },
    );
  };

  return (
    <main className="login">
      <form className="box login-form" onSubmit={submit}>
        <h1 className="wordmark">Factory</h1>
        <label className="field">
          <span>Username</span>
          <input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus />
        </label>
        <label className="field">
          <span>Password</span>
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <ErrorText message={error} />
        <div className="actions">
          <button className="button primary" disabled={isBusy}>
            Sign in
          </button>
        </div>
      </form>
    </main>
  );
}
