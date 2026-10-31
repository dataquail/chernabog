# 1. Use-cases over a domain, behind ports

Status: accepted, 2026-10-22. Decision 1, the CQRS bus, its message
definitions and the unit-of-work library among what was left behind, and the
settled question on folder names are superseded by
[ADR 6](0006-use-cases-become-commands-and-queries.md). The module gateways among
what was left behind are superseded by [ADR 7](0007-module-gateways.md), and
`*.exports.ts` and `*.imports.ts` by
[ADR 13](0013-modules-import-and-export.md).
Specifications, among what was left behind, are adopted by
[ADR 8](0008-repository-vocabulary-and-specifications.md).

## Context

`src/` mixes business rules, persistence and presentation in the same
functions. CLI commands in `main.ts` hold whole use-cases inline, diffing,
recording and printing in one place. Rules such as "a persona that changes
inherited flows gets its own copy first" are written as YAML document surgery
in `repo-config.ts`. One repo has two identities on disk: `paused.json` keys it
by name and `trust.json` by slug. The run lifecycle in `state.ts` is bare SQL
updates that nothing guards. Core functions such as `installRecipes` return
sentences for a person rather than data.

`daemonStatus` already has the shape everything should have: it returns a
`DaemonStatus` record, and `describeStatus` is a pure presenter over it.

## Decision

The code is a set of **use-cases** over a **domain** of aggregates, invoked by
**inbound adapters** (the CLI; the daemon's scheduler and socket; an MCP server
later), with persistence and external systems behind **ports**. The shape
follows dataquail/functional-domain-driven-hexagon. These parts of it are
adopted:

1. **No CQRS bus.** A use-case is a plain `Effect.fn("<name>UseCase")`
   function that adapters call directly. There is no message definition, no
   dispatcher and no routing table.
2. **A real domain with real repositories.** An aggregate is a consistency
   boundary. Its invariants live in pure ops in `domain/`, and it is loaded and
   saved only through a repository port. Storing it as YAML, JSON or SQLite
   changes the adapter, not the need for one.
3. **The reference's aggregate style.** The root is a `Schema.Class` value
   (`XRoot`). Its operations are pure free functions in an `XRootOps` bag that
   return `Result<Outcome, DomainError>`. The data has no methods.
4. **The use-case's result schema is the contract.** A use-case never prints,
   prompts or sets `process.exitCode`. It returns a `Schema.Class` value and
   fails with tagged errors. Adapters map those to text and exit codes (CLI),
   JSON (`--json`) or MCP tool results.
5. **Prompts belong to adapters.** A command that asks questions part way
   through (`setup`, `init`, `enroll`, `recipes add`) becomes two use-cases: a
   _plan_ that returns the choices and an _apply_ that takes the answers. The
   CLI prompts between them.
6. **Streaming output** (`logs --follow`, step-by-step progress) is a `Stream`
   or a result plus events. It is never `Console.log` inside a use-case.
7. **Each adapter chooses which use-cases it exposes.** `trust` is a security
   gate: a person approves the `.chernabog/` code that agents will run. It is
   never exposed to an agent-facing adapter such as MCP.
8. **goodbones enforces the layering**, adopted as the reference adopts it: the
   oxlint plugin runs in `bun run lint`, and the `architecture` CLI runs the
   graph rules and ratchets (`architecture.yaml`).
9. **The migration is incremental**, one slice per pull request, as a
   `gh stack`.

These parts of the reference are left behind: the CQRS bus and its message
definitions; specifications, unless a query needs a reusable predicate; the
unit-of-work library; the event bus, sagas and outbox; authorization policies;
and the `*.platform.ts`, `*.exports.ts` and `*.imports.ts` module gateways (one
process, one package). Adopt one later when a concrete need shows up, not for
symmetry.

The open questions were settled as follows:

- **Trust is its own aggregate** (`TrustRecord`, keyed by slug), kept in
  `trust.json`, apart from the config a person edits by hand.
- **Paused state stays in `paused.json`**, now keyed by slug. Runtime state
  stays out of the hand-edited `config.yaml`, and a migration rewrites the old
  name keys.
- **The folders are `use-cases/` and `*.use-case.ts`.** Without a bus there
  is nothing to separate commands from queries.
- **No goodbones campaigns yet.** The legacy tier's `unrestricted` ceiling and
  the coverage floors are the ratchet for now.

## Consequences

- `src/modules/<module>/{domain,use-cases,infrastructure}/`, `src/kernel/` and
  `src/interface/` are policed tightly from their first file. The flat legacy
  files are one `unrestricted` node, which empties as slices move out of it.
- GitHub issues, pull requests, reviews, CI and labels are not aggregates,
  because GitHub owns them. They come in through client ports as read models.
- `config.yaml` is hand-edited and keeps its comments, so its repository
  adapter applies an aggregate's changes onto the YAML document rather than
  re-serializing it. The daemon, the CLI and the person's editor all write
  the file: `load` always re-reads it, and `save` is one atomic write.
