# Architecture

Detail behind the [README](../README.md): packages, task lifecycle, the worker protocol, review hooks and design decisions.

## Packages

| Package | Role |
|---|---|
| `packages/core` | Domain model and rules: task and project types (a started task carries its `Execution`: token hash, worker state, heartbeat, console), the views each audience gets (`TaskView`, `AgentTaskView`), the status machine, pure operations (`startTask`, `addDecision`, `markReady`, …) the worker lifecycle (`pendingWork`, `acceptWork`, `releaseWorker`, …), task and pull request events (`pullRequestEvents` derives the latter from two saved versions of a task), and the ports (`TaskRepository`, `ProjectRepository`, `ExecutionRuntime`, `PullRequestReader`, `PullRequestWriter`, `Reviewer`). No I/O. |
| `packages/control-plane` | HTTP server on `127.0.0.1:4700`. Engineer API (`/projects`, `/tasks`), MCP endpoint (`/mcp`), agent API (`/agent/*`, token-authenticated), static web UI. Reads go through the `TaskStore`; changes through one service per actor: `TaskService` (engineer), `AgentService` (agent and runner), `LifecycleService` (the dispatcher). Adapters: SQLite repositories (`node:sqlite`), `PodmanRuntime`, `PodmanReviewer` and `GitHubPullRequests` (REST API). The `Dispatcher` reconciles every 2 s; the `PullRequestObserver` polls GitHub every minute; `Hooks` react to task and pull request events. |
| `packages/reviewer` | The reviewer image, with three roles picked by its first argument, each with its own system prompt. `spec` reads one task specification with its project and the project's other tasks; `input` reads a supervised task waiting for input, with its open questions and approval requests, and may read the repository and pull requests with `gh` and `git` for context; `pr` reads one pull request reference (URL, head commit, the task it was opened for) and lets the model read the pull request itself with `gh` and `git`. Each takes the request as JSON on stdin, runs one `claude -p` turn with structured output (without tools for `spec`), and prints the answer as JSON on stdout. |
| `packages/executor` | The container image. Its runner asks the control plane for work, clones the repository, runs one agent turn per piece of work and, once there is none, waits for a nudge on its doorbell; the session state stays on the container's disk, so a restarted runner resumes it. Two agent adapters behind the `AgentSession` port: the `claude` CLI (one process per turn) and `opencode serve` (one HTTP session). The agent reports through a stdio MCP bridge (`report_plan`, `report_decision`, `ask_question`, `report_ready`, …). |
| `packages/web` | React + Vite UI: project sidebar, per-project board and dashboard with its open pull requests, task detail with timeline, question and approval forms, follow-ups. Polls the engineer API. |
| `packages/mcp` | Stateless Streamable HTTP MCP handler, mounted by the control plane at `/mcp`, that lets an MCP client create and inspect projects and tasks through the engineer API. |

## Task lifecycle

- **draft → clarification_required:** the engineer, or an MCP client through
  `request_clarification`, holds a draft with a note on what is unclear. The
  task stays editable; starting it queues it, "Back to draft" settles the note
  without queueing.
- **draft → queued:** the engineer starts the task. The dispatcher starts queued
  tasks in board order while fewer than `FACTORY_MAX_RUNNING` workers are
  working (see *Workers* below); an idle one takes no slot.
- **Dependencies:** a task may list tasks of its project in `dependsOn`, set on
  creation or with `PATCH /tasks/:id` until it starts. A queued task
  waits until every one is `done`, without taking a slot, so a whole chain can
  be queued at once. A failed dependency holds it until restarted and done.
  Cycles are refused, and so is deleting a task an unstarted one depends on.
- **in_progress:** the runner prompts the agent; the agent reports a plan,
  decisions, artifacts and pull requests as it works.
- **input_required:** supervised tasks only. The agent asked a question or
  requested approval of a decision or artifact; the task resumes once every
  question is answered and every approval reviewed. The input review hook
  (see *Hooks*) settles what it can on the engineer's behalf first.
- **ready → done:** the agent reported its work complete. Once its worker is
  idle and none of its pull requests is open as last recorded (see *Pull
  request events*), the dispatcher marks it `done` (immediately when it has
  none), then removes the execution server.
- **failed:** the agent or runner reported a failure, the engineer cancelled, a
  turn ended without an outcome, or a working execution server sent no
  heartbeat for 60 s (5 min after it was started or notified). Time the
  control plane itself was paused does not count: when the host sleeps, the
  execution servers sleep with it. A failed task
  keeps its execution server for `FACTORY_FOLLOW_UP_WINDOW_HOURS`, so a
  follow-up can resume the same agent session.
- **Changelog:** every change to title, specification, labels or status is
  appended to the `task_changes` table with its time, old and new value and
  actor: `user` for the engineer API (web UI and MCP server), `agent` for the
  agent API (the agent and its runner), `reviewer` for the reviewer acting on
  the engineer's behalf, `system` for the dispatcher. The task page shows it as
  a compact timeline; `GET /tasks/:id/changes` returns it.
- **Spec review:** see *Hooks* below. A draft the reviewer finds off topic or
  underspecified moves to `clarification_required` with its comment as the
  note, logged with actor `reviewer`.
- **Follow-ups:** while the task has its execution server, the engineer can
  send messages; one moves a `ready` or `failed` task back to `in_progress` and
  notifies the execution server.
- **Item ids:** questions, decisions, artifacts and follow-ups get random ids
  with a kind prefix (`q-…`, `d-…`, `a-…`, `f-…`). A restart empties these
  lists, so counted ids would repeat, and a review still running from the
  earlier run could then settle an item of the new one.
- **Pull requests:** see *Pull request events* below. A review submitted on
  GitHub reaches the agent as a follow-up.

## Workers: working and idle

The control plane tracks whether a worker has work, not whether its execution
server runs. An idle worker shows since when it is idle; whether the runtime
keeps the execution server running or suspends it meanwhile is the runtime's
choice. The protocol is ping and pong over one endpoint, `POST
/agent/heartbeat`, plus a doorbell on the execution server:

1. The dispatcher starts the execution server (`podman run`) and marks its
   worker `working`.
2. The runner asks for work: a heartbeat with phase `awaiting_work`. The reply
   carries the work, or nothing.
3. With work, the runner accepts it (`POST /agent/work/accept`, which marks its
   follow-ups delivered), runs one agent turn and sends a heartbeat every 15 s
   meanwhile. Then it asks again.
4. With nothing, the control plane marks the worker `idle` with the time (and
   fails a task still `in_progress`: its turn ended without an outcome). The
   runner waits for a nudge on its doorbell, `POST /nudge` on port 4097, and
   sends no heartbeats meanwhile.
5. When work arrives (the first task, a follow-up, or the last answer or review
   of a task awaiting input), the dispatcher marks the worker `working` and
   notifies the execution server through the runtime; the runner resumes at
   step 2.

Work is what the control plane owes the runner and computes from the task: the
task itself until a runner accepted it, then undelivered follow-ups and the
questions and approval requests settled since the last acceptance. A nudge
carries nothing, so a lost reply is simply asked for again, and an unaccepted
piece of work is handed out again. A working worker that goes silent, or a
notified one that never asks for its work, is released and restarted
(`podman restart`); the restarted runner asks for work by itself.

The Podman runtime keeps idle containers running and rings their doorbell on
a loopback port; one that stopped anyway is started instead. A runtime whose
provider suspends idle machines resumes them on the inbound nudge. Idle
containers count toward no limit, so on Podman they hold their memory until
the task is done or its follow-up window ends.

## Pull request events

The `PullRequestObserver` reads every open pull request of a task in
`in_progress`, `input_required` or `ready`, or `failed` while it keeps its
execution server, once a minute: title, status, head commit and submitted
reviews by people with a say on the repository (the author's own replies to
review threads are not reviews). It records what changed through
`LifecycleService.updatePullRequests`, the single entry for pull request
state. On every save, the `TaskStore` compares the task's pull requests before
and after, like the changelog, and publishes after the `task.updated` event:

| Event | When |
|---|---|
| `pull_request.reviewed` | one per review it had not recorded yet; all of them on the first read |
| `pull_request.pushed` | the head commit moved; not on the first read |
| `pull_request.merged`, `pull_request.closed` | the pull request left `open` |

Events are derived from recorded state, not from how it was learned. A GitHub
webhook can therefore replace the observer: it records the same changes
through `updatePullRequests` (finding the task by pull request URL) and the
observer's loop in `main.ts` is dropped; hooks and dispatcher stay as they are.
Polling adds up to a minute of latency, and a change that is undone between
two reads (a push followed by a force-push back) raises nothing.

## Hooks

The `TaskStore` publishes a `task.created` or `task.updated` event (with actor
and changelog entries) after every save, followed by its pull request events. `Hooks` hands each event to every
registered hook in the background: the request that caused it never waits, and
a failing hook is logged and affects no other. A hook implements `{ name,
handle(event) }` and is registered in `main.ts`. Hooks run in memory, so one
still running when the control plane stops is lost.

All three review hooks call the `Reviewer` port: one container image, one
role per kind of review.

The **spec review hook** reviews a draft when it is created, when the engineer
edits its title or specification, and when it returns to draft from
`clarification_required`. It calls `Reviewer.reviewSpec`, a synchronous request
with one answer: `ready`, or `needs_clarification` with a comment.

- `ready` leaves the task a draft: starting it stays the engineer's call.
- `needs_clarification` holds the task for clarification, but only if it is
  still a draft and unchanged since the reviewer read it; otherwise the verdict
  is discarded.
- At most one spec review per task runs at a time; edits made meanwhile get one
  more review of the latest version once it finishes.
- A failed review (no image, no credit, timeout) is logged and leaves the task
  a draft.

The **input review hook** stands in for the engineer when a supervised agent
asks for input, in every project. Whenever the agent leaves its task
`input_required` with open questions or approval requests the hook has not
handed to the reviewer yet, it calls `Reviewer.reviewInput` with the project,
the whole task as the agent reported it (specification, plan, pull requests,
earlier questions, decisions and artifacts) and the ids of those open items.
The reviewer may read the repository and the task's pull requests for
context. For each item it answers one of `answer` (questions),
`approve` or `request_changes` with a comment (decisions and artifacts), or
`leave_to_human`, always with a rationale for the engineer.

- Answers and reviews are applied at once through the same operations the
  engineer uses, logged with actor `reviewer`, and marked on the item with
  `byReviewer.rationale`; the web UI shows "by the reviewer" with it. The
  agent sees them like the engineer's and never sees the rationale.
- What it leaves stays open for the engineer. Once every item is settled,
  by either, the task resumes as usual.
- Each item goes to the reviewer once. Items the agent adds while a review
  runs get one more review; a change that adds none (a plan update, the
  hook's own answers) triggers nothing.
- The engineer may answer while the reviewer works; whichever comes first
  counts. A response for an item that is no longer open, or that does not
  fit it (an option not offered), is logged and dropped.
- A failed review (no image, no credit, timeout) is logged and not retried:
  its items stay with the engineer. The container is removed after 10
  minutes without an answer.
- Which items it settles rests on a model's judgment and its instructions:
  give input only when confident and cheap to correct; leave product calls,
  scope, security, irreversible steps and the engineer's preferences to
  them. Like the PR reviewer, it gets the full tool set and the factory's
  GitHub token, and only its instructions keep it read-only.
- Which items were handed to the reviewer is kept in memory, so after a
  control plane restart the open items of a waiting task are reviewed again
  on the agent's next change, if any.

The **PR review hook** reviews each open pull request of a task once the task
turns `ready`, in every project. It reads the pull request's head commit and
calls `Reviewer.reviewPr` with the pull request's URL, that commit and the
task's title and specification. The reviewer reads the pull request itself
(description, diff, CI checks, and the surrounding code if it needs to) and
answers with a risk level, `low`, `medium` or `high`, and a comment. The hook
always posts its decision as a conversation comment on the pull request. If the
risk is `low` and the project has **auto-merge** on (off by default; set it on
the project form or with `autoMerge` on `POST`/`PATCH /projects`), it then
merges the pull request into its base branch; the dispatcher reads it as merged
and marks the task `done`. Anything else stays open, and the comment lists what
a human reviewer should check.

- The comment is posted before the merge. If it cannot be posted, nothing is
  merged.
- Auto-merge is read once the review is done, so switching it meanwhile counts.
- The merge is pinned to the head commit read before the review. If the agent
  pushes in the meantime, GitHub refuses the merge.
- The reviewer waits up to 10 minutes for pending checks; failing checks rule
  out `low`, and checks still pending after that leave it at `medium` at most.
  The container is removed after 15 minutes without an answer.
- A failed review (no image, no credit, timeout, GitHub error) or a refused
  merge (conflict, branch protection, a repository that allows only squash or
  rebase) is logged and commented, and not retried. The failed-review comment
  leaves the cause out, since that is container output; the refused-merge
  comment quotes GitHub's answer.
- Pull requests run one after another, so each merges into the base the
  previous one moved.
- The task may move on during a review (a follow-up, a cancel, a restart).
  The hook reads it again before it posts a decision and once more before it
  merges: only while the task is still `ready` and the pull request is still
  one of its open ones does it act. Otherwise the decision is logged and
  dropped; if the task changed only while the decision was posted, a second
  comment says the pull request was not merged.
- One run per task goes at a time. A task that turns `ready` again outdates
  the running review: its decisions are dropped, and the newer run reviews the
  open pull requests once the earlier one ended.
- A review never resumes the task: the hook's comments are conversation
  comments, which the factory never reads back.
- The reviewer gets the full tool set and the factory's GitHub token, with
  write access. Only its instructions keep it from commenting, merging,
  pushing or running the repository's code. It reads text the coding agent
  wrote and is told to treat that as data and to rate text addressed to it as
  `high`. Still, a merge without a human rests on a model's judgment: turn on
  auto-merge only for projects where that risk is acceptable.
- Only the transition to `ready` triggers it. A follow-up that leaves the task
  `ready` again triggers a new review.

The **pull request reviewed hook** hands each `pull_request.reviewed` event to
the task's own agent as a follow-up, logged with actor `system`, which resumes
a `ready` or `failed` task. The follow-up names the review and tells the agent
to use the `address-pr-review` skill, which the executor image installs under
`~/.claude/skills` from `packages/executor/skills`. The skill reads the review
and its inline comments, classifies each as worth fixing or not, fixes the
worthwhile ones on the pull request's branch, pushes, replies to every comment
(`Fixed in <sha>` or `Won't fix: <reason>`) and reports ready again, which
starts another PR review.

- An approval without a body triggers nothing. Its inline comments, if any,
  are missed: the observer lists reviews, not their comments.
- A task without an execution server (done, or failed past its follow-up
  window) cannot take the follow-up; the hook fails and is logged.
- The agent's replies are written with the token that opened the pull request,
  so the observer does not read them as new reviews, and the PR review hook
  only writes conversation comments: neither loops back.

`PodmanReviewer` runs `podman run --rm -i` on the reviewer image per review,
with the role (`spec` or `pr`) as argument, passes the request on stdin and
reads the answer from stdout. It gets the Anthropic credential by name, and for
an input or PR review `GITHUB_TOKEN` too. A spec review is removed after 5 minutes without
an answer. Another runtime only needs to answer the same JSON request, for
example behind an HTTP endpoint.

## Design decisions and reasoning

- **The control plane is the source of truth.** Agents never talk to each other
  or to the engineer directly; everything goes through its API and lands in one
  SQLite file. That keeps state inspectable and lets any container die without
  losing what was reported.
- **Work is pulled; only a doorbell is pushed.** The control plane hands out
  work in heartbeat replies. Its one inbound call into an execution server is
  a nudge without content, so a provider can suspend an idle server and resume
  it on that request, and a spurious nudge only makes the runner ask for work
  with its token. The doorbell is unauthenticated for that reason.
- **The runner is deterministic; the agent is not.** Liveness and work delivery
  are plain code in the runner; `done` and pull request status are plain code
  in the control plane. The agent only reports content and `ready`/`failure`.
- **One task, one container, one session.** The container is the sandbox: the
  agent runs without permission prompts and installs toolchains with `mise`.
  The orchestrator prompt makes the agent delegate planning, implementation and
  verification to subagents to keep its own context small.
- **Autonomy is per task.** `autonomous` tasks record decisions and artifacts
  but never block; the API rejects questions and approval requests. `supervised`
  tasks may stop for input.
- **Pure core, thin adapters.** Every domain rule is a pure function in
  `packages/core`, tested without I/O. Services load a task, apply one
  operation, save it. Execution state lives apart from the task's content, so
  a view hides one field, not a list of them. The runtime and the coding agent sit behind ports, so
  Podman and claude/opencode can be swapped.
- **Projects group tasks.** A project has a title and a markdown description that
  the agent reads; agents can look at the other tasks of their project to avoid
  duplicate or conflicting work. Board ranks are global, so dispatch order holds
  across projects.
- **Repositories are not registered.** A task names its repository URL (or none,
  for tasks that only produce artifacts). One GitHub token must therefore cover
  every repository a task may target.
- **Loopback only, no login.** The engineer API and the MCP server have no
  authentication and listen on `127.0.0.1`; requests whose `Host` or `Origin` is
  not loopback are rejected to stop DNS rebinding and cross-site requests.
- **Usage is tracked, not limited.** Each agent turn reports its wall-clock
  duration and the agent's cost estimate at list prices; the control plane sums
  them per task.


## Known gaps

Found in a review of the whole project (2026-11-16), most severe first. Each
names the problem and the intended fix; none is solved yet.

1. **Execution servers can call the engineer API.** Containers reach the
   control plane through `host.containers.internal`, which lands on the
   host's loopback, and the browser guard only checks the `Host` and `Origin`
   headers, which a client sets itself. An agent that sends
   `Host: 127.0.0.1` can approve its own approval requests, turn on
   auto-merge, cancel, delete or follow up on other tasks, and read other
   tasks' agent console passwords; the same holds for `/mcp`. Fix: an engineer
   token generated at startup and required on every route outside `/agent/*`,
   handed to the web UI through a tokenized URL printed at startup and to MCP
   clients with `--header`. A separate port does not help: containers reach
   every loopback port.
2. **Credentials are broader than a task needs.** Every agent and the reviewer
   get the factory's `GITHUB_TOKEN`, which may push to and merge in every
   repository it covers, and the reviewer gets write access while it reads
   text the coding agent wrote. `supervised` and low-risk-only auto-merge are
   therefore advisory against an agent misled by repository content. Fix:
   short-lived GitHub App installation tokens per task, scoped to its
   repository; a read-only token for the reviewer.
3. **Hooks are not durable.** A PR review still running when the control plane
   stops is lost, and since only the transition to `ready` triggers one, the
   task stays `ready` with its pull requests open and nothing says so. Fix: the
   dispatcher finds `ready` tasks whose pull requests were never reviewed at
   their head and starts the review.
4. **The MCP server covers only part of the engineer API.** It cannot answer
   questions, review approval requests, send follow-ups, move tasks or edit
   projects, so an engineer working only through MCP cannot unblock a task
   that waits for input.
5. **The HTTP API has no single contract.** The web UI, the MCP server and the
   executor each carry a hand-written client with its own parsing of the error
   envelope, and response shapes differ (the agent API wraps a task as
   `{ task }`, the engineer API returns it bare). Runner image and control
   plane are not checked to speak the same protocol version, so a stale image
   fails obscurely. Fix: route paths and request and response types in core,
   and a protocol version header on agent API requests.
6. **The dispatcher acts on stale lists.** It awaits the runtime per task, so
   later tasks of a pass are judged on a list that may be seconds old, e.g.
   for heartbeat silence. Waking idle workers also ignores
   `FACTORY_MAX_RUNNING`, which is therefore no hard limit.
7. **Whole tasks are read and written as one JSON document.** Every dispatcher
   pass parses every task several times, finished ones and artifact contents
   included, and the web UI polls full task views every 3 s. Cost grows with
   history. Fix: narrower queries for the dispatcher and summary views for
   lists.
8. **The database has no schema version.** Readers fill defaults for data
   stored before a field existed, but no `user_version` or migration step
   records which format the file holds.
9. **"Review" names five things:** the engineer's review of an approval
   request (`Review`), the spec, input and PR reviews of the reviewer, and
   reviews submitted on GitHub (`PullRequestReview`). The comment in
   `main.ts` that calls `host.containers.internal` unverified is stale.
