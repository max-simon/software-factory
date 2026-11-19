# Architecture

Detail behind the [README](../README.md): packages, task lifecycle, the worker protocol, review hooks and design decisions.

## Packages

| Package | Role |
|---|---|
| `packages/core` | Domain model and rules: task and project types (a started task carries its `Execution`: token hash, worker state, heartbeat, console), the views each audience gets (`TaskView`, `AgentTaskView`), the status machine, pure operations (`startTask`, `addDecision`, `markReady`, …) the worker lifecycle (`pendingWork`, `acceptWork`, `releaseWorker`, …), task and pull request events (`pullRequestEvents` derives the latter from two saved versions of a task), users and identity (`User`, `ExternalIdentity`, `Principal`, `createUser`, …), personal access token metadata and its validation (`AccessToken`, `parseAccessTokenName`, …), the task provider registry and attachments of a project (`taskProviderTypes`, `parseTaskProviders`, …), and the ports (`TaskRepository`, `ProjectRepository`, `UserRepository`, `AccessTokenRepository`, `Authenticator`, `PasswordHasher`, `ExecutionRuntime`, `PullRequestReader`, `PullRequestWriter`, `Reviewer`, `IssueProvider`). No I/O. |
| `packages/control-plane` | HTTP server on `127.0.0.1:4700`. Login (`/auth/*`), engineer API (`/projects`, `/tasks`) and MCP endpoint (`/mcp`), both behind a browser session or a personal access token; agent API (`/agent/*`, token-authenticated); static web UI. Reads go through the `TaskStore`; changes through one service per actor: `TaskService` (engineer), `AgentService` (agent and runner), `LifecycleService` (the dispatcher). Adapters: SQLite repositories (`node:sqlite`), `PodmanRuntime`, `PodmanReviewer`, `GitHubPullRequests` and `GitHubIssues` (REST API). The `Dispatcher` reconciles every 2 s; the `PullRequestObserver` polls GitHub every minute; `Hooks` react to task and pull request events. |
| `packages/reviewer` | The reviewer image, with three roles picked by its first argument, each with its own system prompt. `spec` reads one task specification with its project and the project's other tasks; `input` reads a supervised task waiting for input, with its open questions and approval requests, and may read the repository and pull requests with `gh` and `git` for context; `pr` reads one pull request reference (URL, head commit, the task it was opened for) and lets the model read the pull request itself with `gh` and `git`. Each takes the request as JSON on stdin, runs one `claude -p` turn with structured output (without tools for `spec`), and prints the answer as JSON on stdout. |
| `packages/executor` | The container image. Its runner asks the control plane for work, clones the repository, runs one agent turn per piece of work and, once there is none, waits for a nudge on its doorbell; the session state stays on the container's disk, so a restarted runner resumes it. Two agent adapters behind the `AgentSession` port: the `claude` CLI (one process per turn) and `opencode serve` (one HTTP session). The agent reports through a stdio MCP bridge (`report_plan`, `report_decision`, `ask_question`, `report_ready`, …). |
| `packages/web` | React + Vite UI: login page, account page (display name, password, access tokens), project sidebar, per-project board and dashboard with its open pull requests, task detail with live activity, timeline, question and approval forms, follow-ups. Polls the engineer API. |
| `packages/mcp` | Stateless Streamable HTTP MCP handler, mounted by the control plane at `/mcp`, that lets an MCP client create and inspect projects and tasks through the engineer API, passing the caller's session cookie and `Authorization` header on to it. |

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
- **input_required:** supervised tasks: the agent asked a question or
  requested approval of a decision or artifact; the task resumes once every
  question is answered and every approval reviewed. The input review hook
  (see *Hooks*) settles what it can on the engineer's behalf first.
- **ready → input_required:** any task, once the PR review hook (see *Hooks*)
  left one of its pull requests open, logged with actor `system`. The
  engineer acts on the pull request: once none is open any more, the
  dispatcher marks the task `done` as for `ready`; a follow-up moves it back
  to `in_progress`, also as for `ready`.
- **ready → done, input_required → done:** the agent reported its work
  complete. Once its worker is idle and none of its pull requests is open as
  last recorded (see *Pull request events*), the dispatcher marks it `done`
  (immediately when it has none), then removes the execution server. A task
  with an unanswered question or a pending approval is never marked `done`.
- **failed:** the agent or runner reported a failure, the engineer cancelled, a
  turn ended without an outcome, or a working execution server sent no
  heartbeat for 60 s (5 min after it was started or notified). Time the
  control plane itself was paused does not count: when the host sleeps, the
  execution servers sleep with it. `markFailed` records `failureReason` and
  `failedAt`, the time the caller passes; a follow-up or restart clears both,
  and tasks that failed before `failedAt` existed lack it. A failed task
  keeps its execution server for `FACTORY_FOLLOW_UP_WINDOW_HOURS`, so a
  follow-up can resume the same agent session.
- **Changelog:** every change to title, specification, labels or status is
  appended to the `task_changes` table with its time, old and new value and
  actor: `user` for the engineer API (web UI and MCP server), `agent` for the
  agent API (the agent and its runner), `reviewer` for the reviewer acting on
  the engineer's behalf, `system` for the dispatcher and the issue sync. A
  `user` entry also carries the `userId` of the signed-in user (entries from
  before users have none). The task page shows it as a compact timeline;
  `GET /tasks/:id/changes` returns it.
- **Who did what:** the engineer API passes the request's `Principal` to the
  services, which record the user's id, never a name: `createdBy` on tasks and
  projects, `authorId` on follow-ups, `answeredBy` on answers, `reviewedBy` on
  approvals. Agent, reviewer and system changes record no user; a follow-up
  the control plane sends on its own (a pull request review or merge
  conflict) is marked `bySystem` and shown as "by the system". The web UI
  resolves these ids through `GET /users` (`id`, `username`, `displayName`,
  `disabled` of every user, for any signed-in caller) and shows the **current**
  display name, with username and id on hover; an id no user has shows as
  itself, and an engineer's change or input stored before users existed as
  "engineer (unattributed)" (so are the system's follow-ups stored before
  `bySystem` existed).
- **Spec review:** see *Hooks* below. A draft the reviewer finds off topic or
  underspecified moves to `clarification_required` with its comment as the
  note, logged with actor `reviewer`.
- **Follow-ups:** while the task has its execution server, the engineer can
  send messages; one moves a `ready` or `failed` task, or an
  `input_required` one without open questions or approvals, back to
  `in_progress` and notifies the execution server.
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

### Live activity

The runner, not the agent, turns the agent's output into short lines
("Running Bash: yarn test", "Writing: …" with the start of a response): it
parses the claude CLI's `stream-json` events or opencode's event stream, so
the agent spends no tokens on it. A heartbeat carries only the latest line,
and the control plane stores only the latest heartbeat of a task (one row,
replaced). For the engineer to follow a turn, the runner also batches every
line and sends it to `POST /agent/activity`, at most once every 2 s and once
more when the turn ends. The control plane keeps these in memory only
(`ActivityFeed`): up to 300 lines per task and 50 tasks, the least recently
active task dropped first. Accepting work starts a new turn and drops the
previous one's lines. A control-plane restart loses them, and a failed batch
is not resent. Finishing a task keeps its lines. `GET /tasks/:id/activity`
returns the latest turn's lines; the task page polls it while the task has an
execution server ("Live activity") and loads it once otherwise ("Last
activity"), hiding the section when there are none.

### Usage limits

When the agent's account hits a usage limit, the task pauses instead of
failing and continues by itself once the limit resets.

- **Detection (claude only).** The claude adapter watches the CLI's
  `stream-json` events for `rate_limit_event`: its `rate_limit_info.status`
  is `allowed`, `allowed_warning` or `rejected`, and `resetsAt` is when the
  limit resets, in Unix seconds. A turn that ends in an error (non-zero exit,
  or a `result` event with `is_error`) after the latest such event said
  `rejected` hit the limit; the reset time comes from that event. The message
  text is not parsed. opencode turns that hit a limit fail as before.
- **Report.** The runner sends `POST /agent/usage-limit` with `resetsAt` (UTC
  ISO timestamp, optional) instead of a failure. The control plane records it
  on the execution as `usageLimit` (`since`, `resetsAt`, `resumesAt`) and the
  task stays `in_progress`. `resumesAt` is a minute after the reset, at least
  a minute from now for a reset already past, at most 8 days ahead (Claude's
  longest limit is weekly), and 30 minutes from now without a reset time; a
  session resumed too early only hits the limit again and pauses once more.
  A report that cannot be sent fails the task with the CLI's error.
- **Pause.** Until `resumesAt`, the task has no work: the runner's request for
  work idles its worker without failing the task, and follow-ups wait. Queued
  tasks of the same agent are not started meanwhile, since every task of an
  agent runs on the same credential; other agents' tasks start as usual.
- **Resume.** From `resumesAt` the task has work even if nothing new arrived,
  so the dispatcher notifies its idle worker as for any work. Everything is
  derived from the stored task, so a restarted control plane resumes it too.
  Accepting work clears `usageLimit`. A resumed session gets the cut-off
  turn's prompt again, kept in the runner's session file, with a note that
  part of it may be done, plus any work that arrived meanwhile. A first turn
  keeps no session and starts over from the task, like after a failure;
  follow-ups it had already accepted are not repeated.
- **Cancel.** Cancelling removes the execution and the pause with it.
- **Web UI.** The task page shows "Paused: usage limit, resumes …" in place of
  the heartbeat, the board card "usage limit", with the reset time on hover.

## Pull request events

The `PullRequestObserver` reads every open pull request of a task in
`in_progress`, `input_required` or `ready`, or `failed` while it keeps its
execution server, once a minute: title, status, head commit, base branch,
whether it conflicts with the base branch, and submitted reviews by people with a say on the repository (the author's own replies to
review threads are not reviews). It records what changed through
`LifecycleService.updatePullRequests`, the single entry for pull request
state. On every save, the `TaskStore` compares the task's pull requests before
and after, like the changelog, and publishes after the `task.updated` event:

| Event | When |
|---|---|
| `pull_request.reviewed` | one per review it had not recorded yet; all of them on the first read |
| `pull_request.pushed` | the head commit moved; not on the first read |
| `pull_request.conflicted` | an open pull request newly conflicts with its base branch, including on the first read; again only after the conflict was cleared |
| `pull_request.merged`, `pull_request.closed` | the pull request left `open` |

Events are derived from recorded state, not from how it was learned. A GitHub
webhook can therefore replace the observer: it records the same changes
through `updatePullRequests` (finding the task by pull request URL) and the
observer's loop in `main.ts` is dropped; hooks and dispatcher stay as they are.
GitHub computes mergeability in the background and answers `mergeable: null`
until it has, for example right after a push to either branch. An unknown
mergeability is not a change: the observer does not record it and
`updatePullRequests` keeps the last known value, so a conflict is not reported
again each time GitHub recomputes it.
Polling adds up to a minute of latency, and a change that is undone between
two reads (a push followed by a force-push back) raises nothing.

## Hooks

The `TaskStore` publishes a `task.created` or `task.updated` event (with actor,
the user's id for a user, and changelog entries) after every save, followed by its pull request events. `Hooks` hands each event to every
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
  engineer uses, logged with actor `reviewer` and no user id, and marked on the item with
  `byReviewer.rationale` instead of `answeredBy` or `reviewedBy`; the web UI shows "by the reviewer" with it. The
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

The hook records each outcome on its pull request as `prReview`: `result`
(`merged`, `risky`, `auto_merge_off`, `review_failed`, `merge_refused` or
`merge_dropped`), the `risk` if the reviewer gave one, and `reviewedAt`. A
later review replaces it, and reading the pull request from GitHub keeps it.
Once a run has handled every open pull request, it asks the lifecycle service
to have the task wait for the engineer: a task still `ready` with an open pull
request whose outcome is not `merged` moves to `input_required` (a merged one
stays `open` until the observer reads it). The web UI lists those pull
requests under "Needs your input" with their risk and reason, and counts them
on the board card; MCP's `get_task` returns `prReview` with each pull request.

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
  comments, which the factory never reads back. An outdated run, or one whose
  task left `ready`, moves no task; the input review hook reacts only to the
  agent's own changes, so this `input_required` does not trigger it.
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

The **pull request conflicted hook** hands each `pull_request.conflicted`
event to the task's own agent the same way. The follow-up names the pull
request and its base branch and tells the agent to use the
`resolve-merge-conflict` skill. The skill merges the base branch into the pull
request's branch (a merge, not a rebase, so the commits reviewers have seen
stay intact), resolves each conflict keeping the intent of both sides, verifies,
pushes without force and reports ready again. A conflict it cannot resolve
safely is aborted: a supervised task asks the engineer, an autonomous one
fails. Non-trivial resolutions are reported as decisions.

`PodmanReviewer` runs `podman run --rm -i` on the reviewer image per review,
with the role (`spec` or `pr`) as argument, passes the request on stdin and
reads the answer from stdout. It gets the Anthropic credential by name, and for
an input or PR review `GITHUB_TOKEN` too. A spec review is removed after 5 minutes without
an answer. Another runtime only needs to answer the same JSON request, for
example behind an HTTP endpoint.

## Users and identity

Users are a core domain concept (`packages/core/src/user.ts`); their storage, the `yarn user` CLI, sessions, personal access tokens and the login routes live in the control plane; the web UI has a login page (any 401 sends it there and back afterwards) and an account page for the display name, the password and personal access tokens.

- **The id is the stable reference.** A `User` has an opaque `id`, generated by
  the control plane and never reused, plus a `username` (unique login handle,
  lowercase, 3–32 of `[a-z0-9._-]`) and a `displayName`. Both may change at any
  time, so other records (changelog entries, creators, answers, approvals,
  follow-ups, sessions, tokens) store only the
  id and look the names up when shown. A disabled user keeps its id and its
  history but can no longer sign in or be changed.
- **Identity providers are adapters.** An `Authenticator` takes `Credentials`,
  a union tagged by `kind`, and resolves a user id or `undefined`. The local
  username and password login is one adapter (`{ kind: 'password' }`, backed
  by a `PasswordHasher`); an OIDC, SAML or GitHub adapter adds its own
  credential variant. Each provider's account maps to a user through an
  `ExternalIdentity` (`provider`, `subject`, `userId`) kept by the
  `UserRepository`; the local provider is `local`. In the control plane,
  `SqliteUserRepository` stores users and identities, the local password's
  scrypt hash sits on the user's `local` identity row, and
  `LocalPasswordAuthenticator` checks it, hashing even for unknown or disabled
  users so timing does not reveal which usernames exist. Operators manage
  users with `yarn user`. Both the account routes and that CLI go through
  `UserAccountService` (create, rename, set or change a password, disable),
  so neither adapter holds account logic of its own.
- **Sessions are the factory's own, however a user signed in.** `POST
  /auth/login` checks `{ username, password }` with the `Authenticator` and
  ends in `SessionService.createSession(userId)`, which an IdP's login route
  will call the same way. The session token is 32 random bytes in a
  `factory_session` cookie (`HttpOnly`, `SameSite=Strict`, `Path=/`,
  `Secure` over TLS); the `sessions` table keeps only its SHA-256. A session
  ends after `FACTORY_SESSION_IDLE_HOURS` (12) unused or
  `FACTORY_SESSION_MAX_DAYS` (7) after login, on `POST /auth/logout`, or when
  its user is disabled (`yarn user disable` deletes the user's sessions, and
  the guard refuses them anyway); ended sessions are pruned on login and on
  lookup. `GET /auth/me` names the signed-in user, `PATCH /auth/me`
  `{ displayName }` renames it. `POST /auth/password`
  `{ currentPassword, newPassword }` checks the new password's length, then
  the current password against the user's `local` hash (a wrong one is 400 `wrong_password`, not 401, so the web
  UI does not take it for an ended session; failures count towards the login
  throttle), stores the new hash, ends every other session of the user and
  revokes all its access tokens, so whoever knew the old password keeps no
  token minted with it.
  Both need a session. Failed logins get one
  generic 401 whether or not the username exists; after 5 failures in a row
  per username, or 50 per client address, the login answers 429 with
  `retry-after` for 30 s, doubling per further failure up to 15 minutes, until
  a success resets it (in memory, so a restart forgets it). The client limit
  is far higher because on loopback every client, agent containers included,
  shares one address: it only caps password spraying across usernames, and
  one person's typos lock out nobody else.
- **Personal access tokens are for clients without a browser.** MCP clients
  and scripts send `Authorization: Bearer fct_…`; the `fct_` prefix makes a
  leaked token easy to recognise. A token is `fct_` plus 32 random bytes
  (base64url), shown once by `POST /auth/tokens` or `yarn user token`; the
  `access_tokens` table (`id`, `user_id`, `name`, `token_hash`, `created_at`,
  `last_used_at`, `expires_at`, created with `CREATE TABLE IF NOT EXISTS` like
  every other table) keeps only its SHA-256. `last_used_at` is written at most
  once a minute per token, like a session's `last_seen_at`. A token has an
  optional expiry of 1–3650 days; an expired one stays listed until its owner
  deletes it. `GET /auth/tokens` lists the caller's own tokens (never the
  token or its hash), `DELETE /auth/tokens/:id` revokes one of them (404 for
  anyone else's). These routes and `POST /auth/logout` need a session: a
  token-authenticated request gets 403 (as on `PATCH /auth/me` and `POST
  /auth/password`), so a leaked token cannot mint further
  tokens that would outlive its revocation. Tokens of a disabled user are
  refused at authentication, and `yarn user disable` deletes them as well.
- **Services act for a `Principal`**, `{ userId, via: 'session' | 'token' }`,
  resolved by the HTTP layer (a guard in front of every route outside
  `/agent/*` except the login, and in front of `/mcp`, puts it on the
  request). A request with an `Authorization` header is authenticated by that
  header alone, as `via: 'token'`; an invalid one is a 401, not a fallback to
  the cookie, so a client with a revoked token finds out. Without the header
  the session cookie is used, as `via: 'session'`. Services never receive a
  username. There are no roles
  yet: every active user can do everything an engineer can.

## Managed tasks

A managed task is created from an issue on an external provider (GitHub
Issues first). The provider owns title, specification and labels; the
factory owns everything else.

- **Task providers per project.** A project attaches 0..n task providers
  (`Project.taskProviders`), set on the project form or with `taskProviders`
  on `POST`/`PATCH /projects` (the whole list; leaving it out keeps it). The
  registry in `packages/core/src/task-provider.ts` lists the provider types
  the form offers, each with its config fields and its own parser; only
  `github-issues`, configured with `owner/repo`, so far. A repository is
  checked against GitHub's naming rules, attached at most once per project
  (ignoring case) and at most 20 attachments per project; anything else is
  400 `invalid_task_provider`. Several projects may attach the same
  repository. Projects stored before attachments existed attach none.
  Nothing else is configured: the sync looks in exactly the repositories
  projects attach.

- **The link.** `Task.external` holds `provider`, the issue's browser `url`
  and a short display `key` (e.g. `owner/repo#12`). A task without it is an
  ordinary task. The URL is the link's identity: the SQLite repository keeps
  it in a column with a unique index, so a second task linking the same issue
  is refused with `duplicate_external_link`, and `findByExternalUrl` looks
  a managed task up by its issue. Only a server-side caller creates managed
  tasks, through `createTask`'s `meta.external`; `NewTask` has no such
  field, so neither the engineer API nor MCP can set it. A restart keeps the
  link, and both views show it.
- **The edit lock.** `editTask` refuses title, specification and labels of a
  managed task in every status (`externally_managed`, HTTP 409);
  `dependsOn` stays editable under the usual rules. The only way to change
  those fields, plus autonomy mode and model, is `syncManagedContent`, which
  works while the task is `draft` or `clarification_required` and throws
  `not_editable` afterwards, like an edit: the agent works on what it was
  given. It goes through `TaskStore.update`, so the changelog records it.
  Answers, approvals, follow-ups, cancel, restart and rank work as
  for any task; delete does too, but first releases the issue (see Deletion).

### Labels

Labels on the issue are the control channel between the provider and the
factory. The convention is pure code in `packages/core/src/managed-labels.ts`;
adapters use its constants instead of repeating the names. All factory labels
start with `factory`, and each class has one owner:

| Class | Labels | Written by |
|---|---|---|
| Marker | `factory` | human: only issues carrying it are considered |
| Project | `factory:project:<project id>` | human: which factory project the task belongs to |
| Command | `factory:start` | human: start the task; the factory removes it once handled |
| Config | `factory:supervised`, `factory:autonomous`, `factory:model:opus`, `factory:model:sonnet` | human |
| Status | `factory:status:<status>` with hyphens, e.g. `factory:status:input-required` | factory only |
| Content | every label that does not start with `factory` | human: synced into `Task.labels` |

- **Matching.** GitHub label names are case-insensitive, so every label that
  starts with `factory` is matched case-insensitively (`Factory:Start` starts
  the task). The project id keeps the case it is written in; content labels
  are kept exactly as written, in order, each once.
- **Defaults and conflicts.** Without config labels a task is `autonomous`
  and runs on `opus`. Both autonomy labels, both model labels or several
  project labels naming different projects are a conflict: the default
  applies (no project, for the project label) and `parseManagedLabels`
  returns a human-readable note for each.
- **Unknown labels.** A `factory*` label outside the table (e.g.
  `factory:typo`, `factory-bug`) is ignored and is not a content label.
- **Status.** `statusLabelChanges` computes which labels to add and remove so
  that exactly one `factory:status:*` label, the current one, remains. Any
  other status label is removed, including one a human set; no other label is
  touched.

### Issue provider

- **The port.** `IssueProvider` offers what the factory needs of a provider:
  `listIssues(repos, label)` (every issue of the given repositories carrying
  the label, open and closed, no pull requests; it fails as a whole when any
  repository cannot be listed), `covers(url, repos)` (whether the issue is
  in one of those repositories), `changeLabels` (idempotent) and
  `comment(url, key, body)`, posted at most once per `(url, key)`.
  `listIssues` returns `ExternalIssue`s: the `ExternalLink` fields plus `repoUrl`,
  `title`, `body`, `labels` and `isOpen`.
- **GitHub Issues** (`adapters/github-issues.ts`) uses the REST API with
  `GITHUB_TOKEN` and looks in the repositories it is given; it shares its request, Link-header paging and
  Enterprise (`/api/v3`) helpers with `GitHubPullRequests`
  (`adapters/github-api.ts`). It remembers posted comment keys in its own
  `issue_comments` table, `(url, key, posted_at)`, in the factory's SQLite
  file, recording a key only after GitHub accepted the comment: a crash in
  between may post it twice, never lose it. Bodies over GitHub's 65,536
  characters are truncated with a note.
- **The repository comes from GitHub.** A managed task's `repoUrl`, and the
  issue's `key`, are derived from the `html_url` GitHub returns for the
  issue, never from its title, body or labels, nor from the attached
  repositories: they only say where to look, and a transferred issue reports
  its new repository. An issue whose repository cannot be derived is
  rejected. A renamed repository's issues report the new name, so its
  attachment needs the new name too.

### Sync

`IssueSync` (`control-plane/src/issue-sync-service.ts`) makes one pass over
`listIssues(repos, 'factory')`, where `repos` are the GitHub Issues
repositories of every project's attachments (`gitHubIssueRepos`), read anew
each pass, so an attachment counts from the next pass on. `main.ts` runs it
every minute; the first pass runs at start-up. Without attachments a pass
asks GitHub nothing.

- **Import.** An open issue without a task becomes a `draft` task in the
  project its project label names, with the issue's title, body as the
  specification, content labels, autonomy mode and model from its config
  labels, the issue's `repoUrl`, the default agent and `external` set to the
  issue's link. The changelog records it as created by `system`, and the task
  has no `createdBy`; the web UI shows it as created by `system`. The issue
  text goes into the task unchanged and is never interpreted, nor logged.
- **Skipped issues.** A closed issue is not imported. Nor is an issue without
  a project label, or whose label names no known project or a project that
  does not attach the issue's repository (another project's attachment lists
  it, but must not let it into this one); it gets no comment,
  since adding the label later is the expected fix, and a pass logs one line
  at most listing such issues; that includes several project labels naming
  different projects, which therefore get no conflict comment. An issue with
  an empty body gets one comment, key `empty-body`, saying it needs a
  description, and is skipped until it has one.
- **Comment keys.** Every comment about a task has a key starting with the
  task id (`<task id>:task-id`, `<task id>:late-edit`, …). An issue whose
  task was deleted can be imported again as a new task, which then posts its
  own comments instead of finding the old task's keys taken. Only
  `empty-body`, posted before there is a task, is unscoped.
- **Task-id comment.** The issue gets a comment, key `<task id>:task-id`,
  naming its task. The sync ensures it on every pass; the provider posts each
  key once, so this only recovers a comment whose first attempt failed.
- **Updates before start.** While the task is `draft` or
  `clarification_required`, a pass copies title, body, content labels,
  autonomy mode and model into it through `syncManagedContent`, as `system`.
  Nothing is saved when nothing differs. A changed title or body takes a task
  waiting for clarification back to `draft` in the same change, and the spec
  review runs on the new text, as for an engineer's edit; a label-only change
  leaves it waiting. An empty body is not synced; the issue gets the same one
  comment. The project is fixed at import: a changed project label is
  ignored.
- **Start.** `factory:start` on the issue of a `draft` or
  `clarification_required` task first applies any pending update, so the
  task starts with the issue's current text, then starts it with
  `startTask`, the engineer's start, recorded as `system`, and finally
  removes the label (as written on the issue) through `changeLabels`. Whoever
  sets the label vouches for the text as it is; the factory does not check
  who did. While the body is empty the start waits and the label stays. A
  label whose removal failed is seen again on the started task next pass,
  and only removed; on a task in any other status, too, the label is only
  removed. An issue imported in a pass is started in the next one. Starting
  from the web UI works as before.
- **Leaving before start.** A `draft` or `clarification_required` task is
  deleted when its issue is closed, or when the issue is missing from
  `listIssues` because it lost the label. Absence counts only
  when the list call succeeded and `covers` the issue's repository: a failed
  call aborts the pass before anything changes, and a repository no project
  attaches any more is not looked at: its unstarted tasks stay as they are,
  no longer synced. A task keeps syncing while any project attaches its
  repository, even if its own project detached it. Deletion goes through `assertDeletable`, like
  the engineer's: while an unstarted task depends on it, the task stays, the
  refusal is logged and the next pass tries again.
- **After start** the issue no longer steers the task: edits, a closed issue
  or a removed `factory` label have no effect, and it finishes and reports
  as usual. A restart from the web UI queues the task again with the
  specification it had at start; the issue is not read again.
- **Late edits.** Once the task has started (any status other than `draft`
  and `clarification_required`), a pass compares the issue's title, body,
  content labels, autonomy mode and model with the task, normalised as the
  import does. When any differs, the issue gets one comment, key
  `<task id>:late-edit`, saying the task has started, the change is not
  incorporated and a changed specification needs a new issue. The key makes
  it one comment per task, however many edits and passes follow. Content is
  compared, not the issue's update time, which also moves on the factory's
  own comments and label writes; an unchanged issue never gets the comment.
- **Status label.** For every managed task whose issue is listed, a pass
  compares the issue's labels with the task's status after the issue's own
  sync (so a task started in this pass reports `queued`) and calls
  `changeLabels` with `statusLabelChanges` only when they differ. The issue
  then carries exactly one `factory:status:<status>` label, the current
  one; all eight statuses are reported, `draft` included. No state is
  stored: a status label a human sets or removes is corrected on the next
  pass. A started task is reported while its issue is listed, closed or not;
  once the issue loses the `factory` label it is no longer listed and
  reporting stops silently.
- **Conflicts.** Contradictory config labels of an issue with a task get one
  comment listing the notes and saying the defaults apply, posted right after
  the task-id comment on import and checked again on every pass before
  start. Its key, `<task id>:config-conflict:<hash>`, is derived from the
  notes, so the same conflicts are noted once and a new one again.
- **Task reports.** For every managed task whose issue is listed, after the
  status label, a pass posts what `managedComments` (pure, in
  `packages/core/src/managed-comments.ts`) says the task should have
  reported so far; the provider posts each key once, so only new items go
  out. Each comment is short Markdown and names what it is:
  - a clarification request while the task is `clarification_required`,
    with a hint that editing the issue's title or description is the
    answer; keyed by a hash of the note, so a new note is posted again (the
    sync passes the SHA-256 digest in, keeping `node:crypto` out of core,
    which the web UI bundles);
  - each question, with its options, saying it is answered in the factory;
  - each decision, with its options (the chosen one marked) and reasoning;
  - each artifact, by title and kind only;
  - each pending approval request of a decision or artifact, saying it is
    reviewed in the factory;
  - each approved decision, naming the option that stands: the reviewer's
    pick when it overrides the agent's, since the decision comment itself is
    posted once with the agent's pick;
  - each open pull request once the task is `ready`, and each the PR review
    left open while the task is `input_required` (the same key, so it is
    not commented twice);
  - a failure, without the reason, pointing to the factory; keyed by
    `failedAt` (the last update for tasks that failed before it existed).

  Item keys are `<task id>:<item id>` (`…:approval` for requests,
  `…:approved` for approved decisions), so a
  restart, whose items have new ids, and a new failure time are reported
  again. Left out on purpose: artifact content (long, and reviewed in the
  factory) and the failure reason (it can quote container output). Comments
  on the issue are never read back: answers, reviews and approvals happen in
  the factory only. Agent-written text (problems, options, reasoning,
  titles, the clarification note) is untrusted: it goes in as plain text,
  with a zero-width space after every `@` so it cannot mention anyone.
- **Errors.** One failing issue does not stop the others; its error is logged
  with the issue's URL and secrets redacted. A provider call that fails never
  changes the task and is retried on the next pass. The status report and
  the task reports are each guarded on their own, so an earlier failure for
  the same issue does not hold them back.

### Deletion

Deleting a managed task (`DELETE /tasks/:id`, MCP `delete_task`) releases its
issue first, so the sync does not import it again:

- **Order.** The usual check runs first: a delete refused because a task
  that has not started depends on it touches nothing. Then `TaskService`
  removes the labels from the issue (`deletionLabelChanges`), posts one
  comment, stops the execution server and deletes the task.
- **Labels.** `factory`, `factory:start` and every `factory:status:*` label
  are removed. Project and config labels stay, so adding `factory` again
  imports the issue as a new task with the same setup.
- **Comment.** One comment, key `<task id>:task-deleted`, says the task was
  deleted in the factory, its labels were removed and re-adding `factory`
  imports the issue again; scoped by task, so a task imported again and
  deleted again gets its own comment.
- **Failures.** If removing the labels fails, the task is kept and the call
  answers HTTP 502 with `issue_provider_failed`; the cause is logged with
  secrets redacted. If only the comment fails, it is logged and the task is
  deleted anyway: the labels are already gone.
- **Detached repositories.** The issue is released whether or not a project
  still attaches its repository, so attaching it again does not import it
  anew.
- **Only the user's delete.** A deletion the sync performs itself (for an
  issue that was closed or lost its label) does not go through
  `TaskService.delete` and removes no labels.

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
  verification to subagents to keep its own context small. For a managed task
  the first message names the issue, and the agent links its pull requests to
  it by URL: `Closes` in the final one, `Part of` in the others. Linking is
  the agent's job because it writes the pull request body; the control plane
  does not check it.
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
- **Loopback only, with login.** The engineer API and the MCP server listen on
  `127.0.0.1` and need a session cookie from `POST /auth/login` or a personal
  access token as `Authorization: Bearer`; without either
  they answer 401, also for paths that do not exist, so a signed-out caller
  learns nothing about the API. GET requests for web UI files stay open, so a
  login page can load. Before the session or token check, requests whose `Host` or
  `Origin` is not loopback are rejected to stop DNS rebinding and cross-site
  requests; this holds for bearer requests too, so a token does not open the
  API to other machines, and a web page cannot attach one anyway without a
  CORS preflight, which the API does not answer. The MCP handler calls the
  engineer API over loopback with the caller's `Cookie` and `Authorization`
  headers, so the API sees the same user.
- **Usage is tracked, not limited.** Each agent turn reports its wall-clock
  duration and the agent's cost estimate at list prices; the control plane sums
  them per task.


## Known gaps

Found in a review of the whole project (2026-11-16), most severe first. Each
names the problem and the intended fix; only the first is mitigated so far.

1. **Execution servers could call the engineer API (mitigated).** Containers
   reach the control plane through `host.containers.internal`, which lands on
   the host's loopback, and the browser guard only checks the `Host` and
   `Origin` headers, which a client sets itself. An agent that sent
   `Host: 127.0.0.1` could approve its own approval requests, turn on
   auto-merge, cancel, delete or follow up on other tasks, and read other
   tasks' agent console passwords, and the same held for `/mcp`. Now every
   engineer route and `/mcp` need a session cookie or a personal access
   token, which containers do not have; they can only try to log in, which is
   throttled. An agent token sent to the engineer API is refused like any
   unknown bearer token. MCP clients that cannot send the cookie (e.g. `claude
   mcp add --transport http`) send a personal access token as `Authorization`
   header, which the MCP handler passes on like the cookie.
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
