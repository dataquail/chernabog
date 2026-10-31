# 15. Lives and bus factories are named only at the composition roots

Status: accepted, 2026-10-31. Issue #287. Brings over the reference hexagon's
composition-root restrictions (`dataquail/functional-domain-driven-hexagon`'s
`lives-only-from-composition-roots` and `bus-factories-at-composition-roots`).
Supersedes decision 3 of [ADR 6](0006-use-cases-become-commands-and-queries.md).
Amends decisions 1 and 4 of [ADR 12](0012-modules-wire-themselves.md).

## Context

ADR 12 gave each module a `<module>.module.ts` and the roots one list of
modules, but each root still assembled its runtime itself. The CLI's `main.ts`
called `makeEventBus`, and the daemon, `run`, `rehearse` and `cancel` each
merged the engine's modules, their flows, the flows' runtime and the engine in
the same order of their own. Nothing stopped a module from building a bus, or
anything other than a module's wiring from naming a live adapter: the runs'
handler map named state.db's transaction driver, and the runtime's helpers
lived in `flows.client-live.ts`, which other adapters and the runtime imported
for them.

ADR 6 deferred an application-wide `CommandBus` and `QueryBus` until an
adapter needed to dispatch a message it doesn't name. The dashboard is that
adapter, and the daemon's protocol and the dashboard carry the modules'
messages over JSON.

## Decisions

1. **The composition roots are named.** The CLI's `src/interface/cli/main.ts`,
   whose `AppLive` every CLI command and the daemon run under; the daemon's
   `src/interface/daemon/daemon.server.ts` and the `*.main.ts` commands that
   build an engine of their own (`run`, `rehearse`, `cancel`); and the tests'
   harnesses (`test/sdk-fakes.ts`, `test/events.ts`). `architecture.yaml` lists
   them beside the shared runtime.
2. **A runtime is assembled in one place**, `src/interface/application-runtime.ts`
   (the reference's `globals/infrastructure/cqrs/cqrs-runtime.ts`).
   `ApplicationLive` is every module's `layer`, the merged buses over them, the
   one event bus and the unit of work the commands over files declare; a root
   provides only what is its own (the platform, GitHub, a person to ask).
   `engineRuntime({ registry, flows, engine })` is what a root that runs the
   workflow engine adds: the modules' `engine` slot, the buses over every
   module, and the root's flows, over the runtime of its registry and the
   engine it chose.
3. **Bus factories are called only there.** `makeEventBus`, `makeCommandBus`,
   `makeQueryBus` and `mergeDispatchTables` are called in the shared runtime and
   in tests, nowhere else. A path rule can't see through the package's barrel,
   which exports the buses' Tags too, so the `no-bus-factories` members rule
   reads the call, in every module, the platform and the CLI, TUI and daemon
   adapters.
4. **Lives are named only where a module is wired.** A
   `*.client-live.ts`, `*.repository-live.ts`, `*.transaction-driver-live.ts`
   or `*.acl-live.ts` is imported only by a module's `<module>.module.ts` and by tests
   (`lives-at-roots`). The roots never name one: they reach a module through
   its `platform.ts`, which publishes `<Module>Module`. A helper several
   adapters share lives in a file of its own (`runtime/flow-registry.ts`), and
   the runs' unit of work and the flows' runtime are wired in `runs.module.ts`
   (`RunsModule.unitOfWork`, `RunsModule.runtime(registry)`), over a registry
   the root passes. The runtime's own `runtime/sdk-live.ts` is not a port's
   adapter and stays with the interim runtime.
5. **One `CommandBus` and one `QueryBus`**, over every module's dispatchers.
   Each `<Module>Module` publishes `routes`, the groups its `layer`'s
   dispatchers answer and those dispatchers as dispatch tables (the runs add
   `engineRoutes` for `engine`'s). The shared runtime merges them with
   `mergeDispatchTables` and builds each bus with `declaredIn: [...groups]`, so
   a bus whose table doesn't cover its groups fails to build at startup:
   `DuplicateDispatchTag` when two modules answer one tag, `UnroutableTags`
   when a group's tag has no handler; a dispatch nothing routes is
   `MissingHandler`. Outside an engine the buses route what every process has;
   inside one, every module's messages. The per-module dispatchers stay for
   the adapters that name their module. This supersedes ADR 6's decision 3.
6. **Every message crosses JSON.** Each module owns a
   `<module>.serializable.test.ts` that runs the CQRS library's
   `checkSerializable` over its groups and `checkEventsSerializable` over its
   events (`test/serializable.ts`), and expects nothing to be reported.

## Consequences

- A module added to `src/interface/application-modules.ts` is wired, and
  routed by both buses, in every root at once. `test/application-runtime.test.ts`
  checks that the routes cover every group a handler map declares.
- ADR 12's module record carries `routes` (and for runs `engineRoutes`,
  `runtime` and `unitOfWork`) beside its Layers; `RuntimeLayer` and
  `flow-runtime.ts` are gone.
- The handler maps no longer name the unit-of-work library: the runs' unit of
  work is `unitOfWorkOver(StateDbTransactionDriverLive)` in `runs.module.ts`,
  the same helper the file stores' is built with.
- The tests remain a root: they may build an event bus of their own and name
  any Live.
