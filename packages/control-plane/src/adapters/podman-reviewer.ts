import { randomBytes } from 'node:crypto';
import {
  parseInputReview,
  parsePrReview,
  parseSpecReview,
  type InputReview,
  type InputReviewRequest,
  type PrReview,
  type PrReviewRequest,
  type Reviewer,
  type SpecReview,
  type SpecReviewRequest,
  type TaskModel,
} from '@factory/core';
import { runCommand as defaultRunCommand, type RunCommand } from './run-command.ts';

export interface PodmanReviewerOptions {
  image: string;
  model: TaskModel;
  /** Name of the Anthropic credential forwarded from podman's environment. */
  anthropicCredential: string;
  /** Overrides the default of each role. */
  timeoutMs?: number;
  runCommand?: RunCommand;
}

/**
 * A spec review is one model turn without tools. An input review may read the
 * repository and pull requests for context. A PR review reads the pull request
 * with a few commands and may wait up to 10 minutes for its checks. One that
 * takes longer is stuck.
 */
const roles = {
  spec: { timeoutMs: 5 * 60_000, env: [] },
  input: { timeoutMs: 10 * 60_000, env: ['GITHUB_TOKEN'] },
  // The PR review's gh and git read the token themselves.
  pr: { timeoutMs: 15 * 60_000, env: ['GITHUB_TOKEN'] },
} as const;

/** Marks reviewer containers, apart from the execution servers the orphan sweep watches. */
const reviewerLabel = 'factory.reviewer';

/**
 * Runs one throwaway reviewer container per review: the image's role argument
 * picks the kind of review, the request goes in on stdin, the answer comes
 * back as JSON on stdout, and `--rm` removes the container when it exits.
 */
export class PodmanReviewer implements Reviewer {
  readonly #options: PodmanReviewerOptions;
  readonly #run: RunCommand;

  constructor(options: PodmanReviewerOptions) {
    this.#options = options;
    this.#run = options.runCommand ?? defaultRunCommand;
  }

  async reviewSpec(request: SpecReviewRequest): Promise<SpecReview> {
    return parseSpecReview(await this.#ask('spec', request));
  }

  async reviewInput(request: InputReviewRequest): Promise<InputReview> {
    return parseInputReview(await this.#ask('input', request));
  }

  async reviewPr(request: PrReviewRequest): Promise<PrReview> {
    return parsePrReview(await this.#ask('pr', request));
  }

  async #ask(role: keyof typeof roles, request: object): Promise<unknown> {
    const { image, model, anthropicCredential, timeoutMs = roles[role].timeoutMs } = this.#options;
    const name = `factory-reviewer-${randomBytes(5).toString('hex')}`;
    // Credentials are passed by name only: podman copies them from its own
    // environment, so their values never appear on a command line.
    const args = [
      'run',
      '--rm',
      '-i',
      '--name',
      name,
      '--label',
      `${reviewerLabel}=true`,
      '--env',
      `FACTORY_MODEL=${model}`,
      ...[anthropicCredential, ...roles[role].env].flatMap((variable) => ['--env', variable]),
      image,
      role,
    ];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Removing the container ends `podman run`, which settles the call below.
      void this.#run('podman', ['rm', '-f', '--time', '0', '--ignore', name]).catch(() => {});
    }, timeoutMs);
    let result;
    try {
      result = await this.#run('podman', args, { input: JSON.stringify(request) });
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) throw new Error(`the reviewer gave no answer within ${timeoutMs / 1000} s`);
    if (result.code !== 0) {
      const tail = result.stderr.trim().split('\n').slice(-5).join('\n');
      throw new Error(`the reviewer container exited with code ${result.code}: ${tail}`);
    }
    return parseJson(result.stdout);
  }
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`the reviewer printed no JSON: ${stdout.trim().slice(0, 200)}`);
  }
}
