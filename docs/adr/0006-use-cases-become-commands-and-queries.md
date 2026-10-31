# 6. Use-cases become commands and queries

Status: accepted, 2026-10-29. Issue #228. Supersedes decision 1 of
[ADR 1](0001-ddd-use-cases-and-ports.md), the CQRS bus, its message definitions
and the unit-of-work library on that ADR's list of what was left behind, and
its settled question on folder names. Amends decision 1 of
[ADR 3](0003-use-cases-dont-compose-and-recovery-over-clean-stops.md).
Decision 5 is superseded by [ADR 7](0007-commands-declare-their-unit-of-work.md):
every command declares its unit of work.

## Context

ADR 1 adopted dataquail/functional-domain-driven-hexagon without its CQRS bus:
a use-case is a plain `Effect.fn` that each adapter calls directly, and should
a bus be needed, it would be adopted "when a concrete need shows up".

The need has come. The CLI, the TUI and a dashboard to come all ask the
modules for things, and each calls use-cases its own way: there is no one
place where a call is traced, and nothing a command could tell the dashboard
or the notifier when it changes something, without the engine knowing either
exists. `@effect-server-utils/cqrs` has those seams: a message declared once
with its payload, success and failure schemas; a module's handlers registered
in one place; a typed dispatcher per module, which opens a span per dispatch;
and an event bus for when the events come.

## Decisions

1. **A use-case becomes a command or a query** over `@effect-server-utils/cqrs`.
   One that changes anything is a command, in the module's `commands/`; one
   that only reads is a query, in `queries/`. They are classified by what they
   do, not by their name.
2. **The hexagon's layout, kept plain.** Per message, a
   `<verb-noun>.command.ts` or `<verb-noun>.query.ts` declares it with
   `Command.make` / `Query.make`, beside the schema it answers with (the
   `.result.ts` it replaces), and a `<verb-noun>.handler.ts` exports one
   `<verbNoun>Handler`, tested over its ports' fakes in
   `<verb-noun>.handler.test.ts`. The module's `<module>.command-handlers.ts`
   and `<module>.query-handlers.ts` group its messages (`Command.group`),
   register their handlers with the module's live adapters
   (`Command.handlersOf`, over `<module>.layer.ts`) and declare the
   `Context.Service` dispatcher the adapters ask (`TrustCommands`,
   `TrustQueries`), with its live layer.
3. **Adapters dispatch through a module's dispatcher**, never an
   application-wide bus yet: `yield* TrustQueries` and then
   `.FindTrustedTreeQuery({ repo })`. The composition root that runs them
   provides the dispatchers' live layers: `src/interface/cli/main.ts`, whose
   `AppLive` the CLI's commands and the daemon (`chernabog daemon`) both run
   under. A merged `CommandBus` / `QueryBus` comes when an adapter needs to
   dispatch a message it doesn't name, such as the dashboard's.
4. **A handler doesn't dispatch.** ADR 3's decision 1 carries over: a command
   or query never imports another message, handler or use-case. What several
   do together, the adapter that dispatches them composes.
5. **No unit of work yet.** `withUnitOfWork` needs a `TransactionDriver`, and
   the stores that commands write so far are JSON and YAML files, changed
   under a lock and replaced whole (ADR 3). `@effect-server-utils/unit-of-work`
   is a dependency so that the runs module's commands, over SQLite, can
   declare one when they move.
6. **The `cqrs` campaign counts what's left.** `campaigns.cqrs` in
   `architecture.yaml` counts each `*.use-case.ts` still under a module, as a
   read (`read-use-cases`) or a write (`write-use-cases`), in a ledger under
   `.architecture-campaigns/` that may only shrink. A change that moves one
   runs `bun run architecture:clear` and commits the ledger with it. The
   rules for `use-cases/` stay until the last one moves; then they go, with
   ADR 1's decisions that only they enforce.

## Consequences

- `src/modules/trust/` is the worked example: `check-trust` and
  `find-trusted-tree` are queries, `claim-reload` and `trust-repo` are
  commands. Every later move copies it.
- A rule that names `use-cases/` names `commands/` and `queries/` beside it
  while both kinds exist, and the conformance check holds an allowance no
  file uses at zero, so each adapter's allowance for messages is added by the
  move that first needs it.
- A query may call its aggregate's predicates in `*.root-ops.ts`, as
  `checkTrust` asks `TrustRecordRootOps.trusts`; only commands may change an
  aggregate.
- The campaign's last phase dispatches domain events from commands, which is
  where ADR 3's "no domain events yet" is next decided, with a durability
  story for the modules that write files.
