# 7. Each module publishes one platform surface

Status: accepted, 2026-10-31. Issue #284. Supersedes the
`*.platform.ts`, `*.exports.ts` and `*.imports.ts` module gateways on
[ADR 1](0001-ddd-use-cases-and-ports.md)'s list of what was left behind.
Decision 6 is superseded, and decision 4 narrowed, by
[ADR 13](0013-modules-import-and-export.md): a module names another only
through its `*.exports.ts`.

## Context

ADR 1 left the reference hexagon's module gateways behind: one process, one
package, so a module needed no file saying what it publishes. The adapters
reached into the modules instead, and `architecture.yaml` said where, one
allowlist per adapter: the CLI named every module's `commands/*.command.ts`,
`queries/*.query.ts` and handler maps, the TUI and the daemon named the runs
module's `domain/schedule/` value objects and its runtime file by file, and
the daemon's protocol named every `domain/*/*.value-object.ts` and
`*.events.ts`. Nothing said which of those files a module meant to be named,
so moving one meant finding who reached it, and every new adapter's
allowlist grew the same entries.

A module's shape is now settled (ADR 6): its messages, its dispatchers, its
Layers and the results they answer with. That is what a composition root
needs of it, and it fits in one file.

## Decisions

1. **Each module publishes `<module>.platform.ts`**, beside its layer and
   handler maps. It only re-exports, from its own module: the dispatcher
   Tags and their live Layers (`TrustQueries`, `TrustQueriesLive`, …), the
   module's Layers (since ADR 12, its `<Module>Module` in their place), and the results, value objects and events its messages
   answer with and the daemon's protocol carries. It declares nothing (the
   `reexport: false` surface rule), and it re-exports nothing from
   `infrastructure/` or `interface/` but a client's live/fake pair, which a
   root chooses between.
2. **Nothing outside `src/modules/` reaches past it.** `modules/{module}/`'s
   `importedBy` refuses every importer outside the modules but tests
   (`**/*.test.ts`, `test/**`), except through `*.platform.ts`. The
   adapters' allowlists name `@/modules/*/*.platform.ts` and no module path
   below it.
3. **Only the inbound adapters name a platform surface.** `*.platform.ts`'s
   own `importedBy` admits `src/interface/` (the composition roots and the
   adapters they run: the CLI's commands, the TUI, the daemon's server,
   protocol and client) and tests. A module never names another's.
4. **A module names another only through a file it publishes on purpose**:
   `*.platform.ts`, `*.exports.ts` or `*.module.ts`, as a module-wide deny
   that holds whatever a tier's allowlist says. Modules don't read each other
   yet; the adapter that dispatches to both composes them.
5. **The runs module's runtime is published from `runs.platform.ts` for
   now.** The roots still compose the engine, launchers, run logs, the repo
   runtime, agents, the usage gate, labels, steps and the launch shim
   directly. `runs.platform.ts` re-exports what they name, in a section
   marked interim, and its deny exempts `infrastructure/runtime/**`. Each
   line goes when its root stops naming it, and the exemption with the last.
6. **`*.exports.ts` and `*.imports.ts` arrive with the first cross-module
   consumer**, the anti-corruption layer that first needs another module's
   vocabulary. The conformance check holds vacant nodes at zero, so a node
   no file is under can't be declared ahead of it.

## Consequences

- An adapter's allowlist no longer changes when a module moves a file: the
  module's `*.platform.ts` changes instead, and a reviewer reads one file to
  see what a module publishes.
- The legacy `src/repo-config.ts` still reads the enrollment and runs
  modules' internals, and is named in `modules/{module}/`'s `importedBy`
  with that reason. The modules' repositories and runtime import it, so
  naming their platform surfaces from it would close a cycle. It leaves when
  it moves into the enrollment module (ADR 2).
- The test harnesses under `test/` stage a module's fakes and handlers
  directly, as the reference's `test-utils/` does.
