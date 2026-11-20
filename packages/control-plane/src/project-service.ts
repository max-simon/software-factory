import { randomBytes } from 'node:crypto';
import {
  assertTaskProvidersUnclaimed,
  createProject,
  editProject,
  type NewProject,
  type Principal,
  type Project,
  type ProjectEdit,
  type ProjectRepository,
} from '@factory/core';
import { NotFoundError } from './task-store.ts';

export interface ProjectServiceDeps {
  repository: ProjectRepository;
  newId?: () => string;
  now?: () => string;
}

/** What the engineer does with projects; a new project records the id of the user who created it. */
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
    assertTaskProvidersUnclaimed(project.taskProviders, project.id, this.#repository.list());
    this.#repository.insert(project);
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

  edit(id: string, edit: ProjectEdit): Project {
    const current = this.get(id);
    const now = this.#now();
    const next = { ...editProject(current, edit), updatedAt: now };
    assertTaskProvidersUnclaimed(next.taskProviders, id, this.#repository.list());
    this.#repository.save(next);
    return next;
  }
}
