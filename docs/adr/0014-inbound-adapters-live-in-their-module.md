# 14. A module's inbound adapters live in the module

Status: accepted, 2026-10-31. Issue #288. Brings over the reference
hexagon's `modules/<m>/interface/{http,cli,events}/`
(`dataquail/functional-domain-driven-hexagon`, its ADR-0013 and ADR-0023).
Amends ADR 13.

## Context

Each module's CLI commands sat in `src/interface/cli/<module>/`, outside the
module. They reached it through its `platform.ts`, so the module's inbound
side was spread between two trees, and `architecture.yaml` described each
folder there as an exception. The daemon's server likewise answered the runs
module's `/runs/:id` routes beside its own scheduling.

## Decisions

1. **A module's inbound adapters live in `src/modules/<module>/interface/`**,
   a container admitting `cli/`, `daemon/` and `events/`. A CLI command is a
   `<command>.endpoint.ts`, as in the hexagon: in a module,
   `interface/cli/enroll.command.ts` beside `commands/apply-enrollment.command.ts`
   would give `.command` two meanings. Each protocol folder has a
   `<module>.endpoint-groups.ts` that registers its endpoints, may hold the
   output its endpoints share (`*.output.ts`), and admits pure leaf helpers
   (`*.util.ts`, which owe a `*.util.test.ts` and name only effect).
2. **What an inbound adapter may name**: its own module's commands, queries,
   dispatchers (the handler maps), domain and `interface/`, the kernel, the
   CLI's shared framework, the daemon's client and protocol, `home.ts` and
   `version.ts`. Never its repositories or other adapters, nor another
   module's internals.
3. **An inbound adapter may dispatch a peer's grant** through its own
   `<module>.imports.ts`. ADR 3 lets the adapter compose what two modules do
   together, and the ACL route a handler would take doesn't fit here:
   `enroll` needs the machine's setup and `setup` needs enrollment's personas
   in use, so ACL ports on both sides would have each `module.ts` provide the
   other, a cycle. This amends ADR 13, which let only an ACL adapter dispatch a
   grant. The grants: machine's `ReadMachineSetupQuery` (to enrollment), and
   enrollment's `FindCheckoutRootQuery` (to recipes), `ListEnrolledReposQuery`
   (to trust) and `ListPersonasInUseQuery` (to machine). The hexagon's event
   adapters (`interface/events/`) name `imports.ts` the same way.
4. **The roots name a module's endpoint groups directly, not through
   `platform.ts`.** An endpoint asks the daemon over its client, and the
   daemon's protocol is made of the runs module's results, through
   `runs.platform.ts`; publishing the groups from `platform.ts` would close a
   cycle (`runs.platform.ts` → its endpoints → `daemon.client.ts` →
   `daemon.protocol.ts` → `runs.platform.ts`). So a module's
   `interface/*/<module>.endpoint-groups.ts` is the one other file of a module
   that code outside it may name, and only a composition root may: `main.ts`,
   a `*.main.ts`, or the daemon's server.
5. **What stays outside the modules**, and where:
   - `src/interface/cli/main.ts`, the CLI's root.
   - `src/interface/cli/*.main.ts`, commands that are composition roots of
     their own: `run`, `cancel` and `rehearse` build the engine over every
     module (`applicationModules`); `start` and `open-pr` compose the runtime
     the runs module still publishes from `platform.ts` as an interim, and
     the legacy `repo-config.ts`; `doctor` reads machine, runs and trust and
     the legacy `repo-config.ts`; `init` composes enrollment's enroll wizard
     with recipes' scaffolding, endpoints neither module may name of the
     other. Each moves into a module when what it composes does.
   - `src/interface/cli/*.arguments.ts`, `cli.output.ts` and
     `asker.prompt.ts`: the shared framework (the hexagon's
     `globals/infrastructure/framework/`).
   - `src/interface/daemon/`: the protocol, the client, and the server,
     which keeps the scheduling loops, the socket, and the routes that read
     its own state (`/status`, `/reload`, `/run`, `/tick`, and `/cancel`,
     which names a repo by the server's list). The runs module's
     `/runs/:id` and `/runs/:id/history` are its
     `interface/daemon/` endpoints, registered by `runsRoutes`, which takes
     the server's `answer` so a failure still answers as a refusal.
   - `src/interface/tui/`: the TUI, a client of the modules as the hexagon's
     web app is, and `status`, the same status printed.
6. **Tests.** The acceptance tier drives the built CLI and is unchanged. The
   tests that drive a command's pieces (`test/enrollment.test.ts`,
   `test/recipes.test.ts`, `test/follow-run-log.test.ts`) name the moved files.

## Consequences

- `src/interface/cli/` has no per-module folders, and its allowlists name
  only modules' `platform.ts` and endpoint groups.
- The repo-config campaign's ledger follows the five roots that moved up a
  folder; its count is unchanged.
- An endpoint's dispatch of a peer grant is `Effect.scoped`, since
  `Query.dispatcher` builds in a scope.
