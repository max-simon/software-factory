import { randomBytes } from 'node:crypto';
import {
  changeMeta,
  createProject,
  editProject,
  projectChanges,
  type NewProject,
  type Principal,
  type Project,
  type ProjectChange,
  type ProjectEdit,
  type ProjectRepository,
} from '@factory/core';
import { NotFoundError } from './task-store.ts';

export interface ProjectServiceDeps {
  repository: ProjectRepository;
  newId?: () => string;
  now?: () => string;
}

/** What the engineer does with projects; every change records the id of the user who made it. */
export class ProjectService {
  readonly #repository: ProjectRepository;
  readonly #newId: () => string;
  readonly #now: () => string;

  constructor(deps: ProjectServiceDeps) {
    this.#repository = deps.repository;
    this.#newId = deps.newId ?? (() => randomBytes(5).toString('hex'));
    this.#now = deps.now ?? (() => new Date().toISOString());
  }

  create(input: NewProject, by: Principal): Project {
    const project = createProject(input, { id: this.#newId(), now: this.#now(), createdBy: by.userId });
    this.#repository.insert(project, [{ ...changeMeta(project.createdAt, by), field: 'created' }]);
    return project;
  }

  list(): Project[] {
    return this.#repository.list();
  }

  get(id: string): Project {
    const project = this.#repository.get(id);
    if (!project) throw new NotFoundError(`project ${id} not found`);
    return project;
  }

  edit(id: string, edit: ProjectEdit, by: Principal): Project {
    const current = this.get(id);
    const now = this.#now();
    const next = { ...editProject(current, edit), updatedAt: now };
    this.#repository.save(next, projectChanges(current, next, changeMeta(now, by)));
    return next;
  }

  /** Who changed title, description or auto-merge of a project, and when; oldest first. */
  changes(id: string): ProjectChange[] {
    this.get(id);
    return this.#repository.listChanges(id);
  }
}
