/** Groups tasks; every task belongs to exactly one project. */
export interface Project {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  /** Markdown; may be empty. */
  description: string;
  /** Merges the pull requests the PR review rates low risk without a human. */
  autoMerge: boolean;
}

export interface NewProject {
  title: string;
  /** Defaults to empty. */
  description?: string;
  /** Defaults to off. */
  autoMerge?: boolean;
}

export interface ProjectEdit {
  title?: string;
  description?: string;
  autoMerge?: boolean;
}

// Pure, like the task operations: the caller stamps `updatedAt` when saving.

export function createProject(input: NewProject, meta: { id: string; now: string }): Project {
  return {
    id: meta.id,
    createdAt: meta.now,
    updatedAt: meta.now,
    title: input.title,
    description: input.description ?? '',
    autoMerge: input.autoMerge ?? false,
  };
}

export function editProject(project: Project, edit: ProjectEdit): Project {
  return {
    ...project,
    title: edit.title ?? project.title,
    description: edit.description ?? project.description,
    autoMerge: edit.autoMerge ?? project.autoMerge,
  };
}
