import type { Project } from '@factory/core';
import { api } from '../api.ts';
import { href, type CurrentUser } from '../model.ts';
import { setPreference, useThemePreference, type ThemePreference } from '../theme.ts';

const themeOptions: [ThemePreference, string][] = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

export function ThemeToggle() {
  const preference = useThemePreference();
  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Theme">
      {themeOptions.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={value === preference}
          onClick={() => setPreference(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Logs out, then shows the login page; also when the session had already ended. */
async function logOut(): Promise<void> {
  await api.logout().catch(() => {});
  location.hash = href.login();
}

export function Sidebar({
  projects,
  activeId,
  me,
  isAccountActive = false,
}: {
  projects: Project[] | undefined;
  activeId: string | undefined;
  /** The signed-in user; undefined while it loads. */
  me: CurrentUser | undefined;
  isAccountActive?: boolean;
}) {
  return (
    <aside className="sidebar">
      <a className="wordmark" href={href.home}>
        Factory
      </a>
      <nav aria-label="Projects">
        <h2 className="section-title">Projects</h2>
        <ul className="project-list">
          {projects?.map((project) => (
            <li key={project.id}>
              <a
                href={href.project(project.id)}
                className={project.id === activeId ? 'active' : undefined}
                aria-current={project.id === activeId ? 'page' : undefined}
              >
                {project.title}
              </a>
            </li>
          ))}
        </ul>
        <a className="button small" href={href.newProject}>
          New project
        </a>
      </nav>
      <div className="sidebar-footer">
        {me && (
          <div className="sidebar-user">
            <a
              href={href.account}
              className={isAccountActive ? 'active' : undefined}
              aria-current={isAccountActive ? 'page' : undefined}
              title={`${me.username} (${me.id}): your account and access tokens`}
            >
              {me.displayName}
            </a>
            <button type="button" className="link" onClick={() => void logOut()}>
              Log out
            </button>
          </div>
        )}
        <ThemeToggle />
      </div>
    </aside>
  );
}
