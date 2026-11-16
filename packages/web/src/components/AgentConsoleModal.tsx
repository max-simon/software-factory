import { useEffect, useRef, useState } from 'react';
import { api, type AgentConsoleAccess } from '../api.ts';
import { ErrorText } from './ErrorText.tsx';

interface Props {
  taskId: string;
  onClose: () => void;
}

/**
 * Where and how to sign in to the OpenCode console of the task's execution
 * server. The password is fetched only here, so task polls never carry it.
 */
export function AgentConsoleModal({ taskId, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [access, setAccess] = useState<AgentConsoleAccess>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    dialogRef.current?.showModal();
    api.agentConsole(taskId).then(setAccess, (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [taskId]);

  return (
    <dialog ref={dialogRef} className="modal compact" onClose={onClose}>
      <header className="modal-header">
        <div>
          <h2>OpenCode console</h2>
          <span className="muted">This task's execution server, reachable from this machine only.</span>
        </div>
        <button className="link close" aria-label="Close" onClick={() => dialogRef.current?.close()}>
          ✕
        </button>
      </header>
      <div className="console-access">
        {!access && !error && <p className="muted">Loading…</p>}
        <ErrorText message={error} />
        {access && (
          <>
            <dl>
              <dt>Server address</dt>
              <dd>
                <a className="mono" href={access.url} target="_blank" rel="noreferrer">
                  {access.url}
                </a>
                <CopyButton text={access.url} />
              </dd>
              <dt>Password</dt>
              <dd>
                <code>{access.password}</code>
                <CopyButton text={access.password} />
              </dd>
            </dl>
            <p className="muted">
              Choose “Use password” on the sign-in page; the address is filled in. The password changes with every
              execution server.
            </p>
            <div className="actions">
              <a className="button primary" href={access.url} target="_blank" rel="noreferrer">
                Open console
              </a>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}

function CopyButton({ text }: { text: string }) {
  const [isCopied, setIsCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => {
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 1500);
      },
      () => setIsCopied(false),
    );
  return (
    <button className="link" onClick={() => void copy()}>
      {isCopied ? 'Copied' : 'Copy'}
    </button>
  );
}
