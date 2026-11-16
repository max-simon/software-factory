import { fileURLToPath } from 'node:url';
import { createApiClient, createMcpHandler } from '@factory/mcp';
import { ConfigError, loadConfig, unavailableAgent } from './config.ts';
import { GitHubPullRequests } from './adapters/github-pull-requests.ts';
import { PodmanRuntime } from './adapters/podman-runtime.ts';
import { PodmanReviewer } from './adapters/podman-reviewer.ts';
import { SqliteProjectRepository } from './adapters/sqlite-project-repository.ts';
import { SqliteTaskRepository } from './adapters/sqlite-task-repository.ts';
import { Dispatcher } from './dispatcher.ts';
import { Hooks } from './hooks/hooks.ts';
import { InputReviewHook } from './hooks/input-review-hook.ts';
import { PrReviewHook } from './hooks/pr-review-hook.ts';
import { SpecReviewHook } from './hooks/spec-review-hook.ts';
import { agentRoutes } from './http/agent-routes.ts';
import { engineerRoutes } from './http/engineer-routes.ts';
import { createServer, mcpPath } from './http/server.ts';
import { staticFiles } from './http/static-files.ts';
import { PauseWatch } from './pause-watch.ts';
import { ProjectService } from './project-service.ts';
import { ReviewTracker } from './review-tracker.ts';
import { createServices } from './services.ts';

// The engineer API has no authentication, so it must not leave this machine.
const host = '127.0.0.1';
const reconcileIntervalMs = 2000;
const pauseCheckIntervalMs = 1000;
// Built by `yarn web:build`; without it the control plane serves the API only.
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));

// Each pass is scheduled only after the previous one finished, so passes never overlap.
// The first pass runs immediately, which recovers state after a control-plane restart.
function runDispatcher(dispatcher: Dispatcher): void {
  void dispatcher
    .reconcile()
    .catch((error: unknown) => console.error('dispatcher pass failed:', error))
    .finally(() => setTimeout(() => runDispatcher(dispatcher), reconcileIntervalMs));
}

function main(): void {
  const config = loadConfig();
  const repository = new SqliteTaskRepository(config.dbPath);
  const runtime = new PodmanRuntime({
    image: config.image,
    gitUserName: config.gitUserName,
    gitUserEmail: config.gitUserEmail,
    agentCredentials: config.agentCredentials,
  });
  // Hooks need the services, which publish to the hooks, so they are registered once the services exist.
  const hooks = new Hooks();
  const { tasks, service, agent, lifecycle } = createServices({ repository, runtime, onEvent: (event) => void hooks.emit(event) });
  const projects = new ProjectService({ repository: new SqliteProjectRepository(config.dbPath) });
  // One image, three roles: it reviews task specifications, the input agents ask for, and pull requests.
  const reviewer = new PodmanReviewer({
    image: config.reviewerImage,
    model: config.reviewerModel,
    // It runs the claude CLI, so it gets what a claude task gets; claude takes either credential, so it always has one.
    anthropicCredential: config.agentCredentials.claude!,
  });
  const pullRequests = new GitHubPullRequests(process.env.GITHUB_TOKEN!);
  // The hooks record the reviews they run; the engineer API shows them.
  const reviews = new ReviewTracker();
  hooks.register(new SpecReviewHook({ tasks, service, projects, reviewer, reviews }));
  hooks.register(new InputReviewHook({ tasks, service, projects, reviewer, reviews }));
  hooks.register(new PrReviewHook({ tasks, pullRequests, reviewer, projects, reviews }));
  const routes = [
    ...engineerRoutes(tasks, service, projects, (agent) => unavailableAgent(config.agentCredentials, agent), reviews),
    ...agentRoutes(tasks, agent, projects),
  ];
  const server = createServer(routes, {
    staticFiles: staticFiles(webDist),
    // The MCP tools go through the engineer API over loopback, so they get its validation and error mapping.
    mcp: createMcpHandler(createApiClient(`http://${host}:${config.port}`)),
  });
  // Checked on a timer of its own: a host may sleep in the middle of a dispatcher pass.
  const pauseWatch = new PauseWatch();
  setInterval(() => pauseWatch.check(), pauseCheckIntervalMs).unref();
  const dispatcher = new Dispatcher({
    tasks,
    lifecycle,
    runtime,
    // Assumes podman forwards this name to the host's loopback; not yet verified
    // against a running podman machine.
    controlPlaneUrl: `http://host.containers.internal:${config.port}`,
    maxRunning: config.maxRunning,
    followUpWindowMs: config.followUpWindowHours * 3_600_000,
    pullRequests,
    secrets: [...config.credentials.map((name) => process.env[name]!), process.env.GITHUB_TOKEN!],
    awakeSince: () => pauseWatch.check(),
  });
  server.listen(config.port, host, () => {
    console.log(`control plane listening on http://${host}:${config.port} (MCP at ${mcpPath})`);
    runDispatcher(dispatcher);
  });
}

try {
  main();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`control plane cannot start: ${error.message}`);
  process.exitCode = 1;
}
