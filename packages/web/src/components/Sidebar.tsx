import type { Project } from '@factory/core';
import { href } from '../model.ts';
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

export function Sidebar({ projects, activeId }: { projects: Project[] | undefined; activeId: string | undefined }) {
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
      <ThemeToggle />
    </aside>
  );
}
