import { randomBytes } from 'node:crypto';
import { createProject, editProject, type NewProject, type Project, type ProjectEdit, type ProjectRepository } from '@factory/core';
import { NotFoundError } from './task-store.ts';

export interface ProjectServiceDeps {
  repository: ProjectRepository;
  newId?: () => string;
  now?: () => string;
}

export class ProjectService {
  readonly #repository: ProjectRepository;
  readonly #newId: () => string;
  readonly #now: () => string;

  constructor(deps: ProjectServiceDeps) {
    this.#repository = deps.repository;
    this.#newId = deps.newId ?? (() => randomBytes(5).toString('hex'));
    this.#now = deps.now ?? (() => new Date().toISOString());
  }

  create(input: NewProject): Project {
    const project = createProject(input, { id: this.#newId(), now: this.#now() });
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
    const next = { ...editProject(this.get(id), edit), updatedAt: this.#now() };
    this.#repository.save(next);
    return next;
  }
}
