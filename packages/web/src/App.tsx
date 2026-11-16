import type { Project } from '@factory/core';
import { useEffect } from 'react';
import { api } from './api.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { usePolling, useRoute } from './hooks.ts';
import { href, type Route } from './model.ts';
import { ProjectOverview } from './views/ProjectOverview.tsx';
import { EditProject, NewProject } from './views/ProjectForm.tsx';
import { TaskDetail } from './views/TaskDetail.tsx';
import { EditTask, NewTask } from './views/TaskForm.tsx';

const activeProjectId = (route: Route): string | undefined => {
  if (route.name === 'project' || route.name === 'edit-project') return route.id;
  if (route.name === 'new-task') return route.projectId;
  return undefined;
};

export function App() {
  const route = useRoute();
  const { data: projects, error, set } = usePolling(api.listProjects, 'projects');
  // Shows a saved project in the sidebar right away instead of on the next poll.
  const upsert = (saved: Project) =>
    set(projects?.some((p) => p.id === saved.id) ? projects.map((p) => (p.id === saved.id ? saved : p)) : [...(projects ?? []), saved]);
  const width = route.name === 'project' ? ' wide' : '';

  return (
    <div className="shell">
      <Sidebar projects={projects} activeId={activeProjectId(route)} />
      <main className={`page${width}`}>
        {route.name === 'home' && <Home projects={projects} error={error} />}
        {route.name === 'new-project' && <NewProject onSaved={upsert} />}
        {route.name === 'project' && <ProjectOverview id={route.id} />}
        {route.name === 'edit-project' && <EditProject id={route.id} onSaved={upsert} />}
        {route.name === 'new-task' && <NewTask project={projects?.find((p) => p.id === route.projectId)} projectId={route.projectId} />}
        {route.name === 'task' && <TaskDetail id={route.id} projects={projects} />}
        {route.name === 'edit' && <EditTask id={route.id} />}
      </main>
    </div>
  );
}

/** Opens the first project; there is no board across projects. */
function Home({ projects, error }: { projects: Project[] | undefined; error: Error | undefined }) {
  const first = projects?.[0];
  useEffect(() => {
    // Replaces the entry, so the back button does not bounce through home.
    if (first) location.replace(href.project(first.id));
  }, [first?.id]);

  if (!projects) return <p className="muted">{error ? error.message : 'Loading…'}</p>;
  if (first) return null;
  return (
    <div className="empty">
      <p>No projects yet. Every task belongs to a project.</p>
      <a href={href.newProject}>Create the first project</a>
    </div>
  );
}
