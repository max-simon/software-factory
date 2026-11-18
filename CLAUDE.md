# Design rules

These apply to every change in this repository, by people and by the factory's
agents. `docs/architecture.md` describes the packages and the reasoning behind
the design.

## Architecture: hexagonal

- **Core** (`packages/core`) holds the domain: types, rules as pure functions,
  and every port (`core/src/ports.ts`). It does no I/O and imports nothing from
  other packages.
- **Application services** (`control-plane/src/*-service.ts`,
  `control-plane/src/auth/*-service.ts`) run the use cases. A service loads
  data through ports, applies core operations and saves the result.
- **Adapters** translate between the outside world and the services, and hold
  no use-case logic:
  - inbound: HTTP routes (`control-plane/src/http`), the CLI (`user-cli.ts`),
    MCP (`packages/mcp`);
  - outbound: SQLite, Podman and GitHub (`control-plane/src/adapters`).

  A route or CLI command parses its input, calls a service and maps the result
  to its output.
- Dependencies point inwards: adapters → services → core. An adapter never
  imports a service module to get a type, and a route module never imports
  another route module.
- Define a new port in `core/src/ports.ts`, never next to the service that
  uses it.
- **Sinks over pipes**: a component takes its input, does its work and stops.
  It does not trigger the next step itself; the caller (or a hook reacting to
  an event) orchestrates the flow.
- Low coupling, high cohesion. One responsibility per function. Prefer early
  returns to deep nesting.

## Validation and errors

- Validate strictly at the system boundaries: HTTP bodies
  (`http/validation.ts`), CLI arguments, environment (`config.ts`) and
  responses from GitHub or the agents. Inside the system, trust the types and
  don't validate again.
- A parser returns a value whose type is true. Never cast untyped input with
  `as`: check it, or reject it.
- Fail loudly at the boundaries, with typed errors carrying meaningful context
  (`DomainError` codes, `ValidationError`). Inside the system, degrade
  gracefully: retries, fallbacks, safe defaults.
- Writes that belong together (for example several rows, or a record and its
  changelog) go into one transaction.

## Security

- Never hardcode credentials or log secrets. Store only hashes of tokens and
  passwords.
- Never trust unvalidated input, including text written by agents.
- Base security decisions on the real deployment. The control plane listens
  on `127.0.0.1`, so every client, agent containers included, has the same
  remote address.
- When a credential, session or permission changes, check every other
  credential it relates to (sessions, access tokens, identities).

## Simplicity

- Write the minimum code that solves the problem. YAGNI: no unused
  abstractions, no premature optimisation.
- Keep changes surgical: touch only what the task needs, and no drive-by
  refactors.
- Delete dead code right away.
- Split a file once it has more than about 300 lines of non-trivial logic, but
  only along a natural boundary.
- Add a dependency only for a concrete reason, and pin its exact version.
  Prefer the standard library (for example `node:sqlite`, `node:test`,
  `node:crypto`).
- Breaking changes: ask first. Once one is approved, remove the legacy code
  completely: no compatibility shims.

## Naming and comments

- Names describe intent: functions are verbs, values are nouns, booleans read
  as assertions (`isValid`, `hasAccess`).
- Comment the *why* (non-obvious logic, tradeoffs, assumptions), never the
  *what*. Remove stale comments right away.
- When an optional field's absence means something (for example "stored before
  users existed"), find every place that creates that record and make sure
  each one sets the field correctly.

## Review checklist

1. Boundary validation
2. Correctness, edge cases included
3. Conventions (the rules above)
4. Security
5. Performance
6. Breaking changes
