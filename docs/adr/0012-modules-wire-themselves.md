# 12. Each module wires itself in a `<module>.module.ts`

Status: accepted, 2026-10-31. Issue #286. Brings over the reference
hexagon's wiring plane (`dataquail/functional-domain-driven-hexagon`,
ADR 32).

## Context

Each module had a `<module>.layer.ts` merging its live adapters, and each of
its handler maps provided that layer itself. The composition roots then
listed every module's dispatchers by hand: the CLI's `AppLive` merged fifteen
layers, some of them a module's loose adapters, and the daemon, a foreground
run, a rehearsal and a cancel each nested the runs module's dispatchers,
stores, event bus and engine in a fixed order of their own. A module added
once had to be wired in every root, and a root had to know the order a
module's internals were built in.

## Decisions

1. **`<module>.module.ts` replaces `<module>.layer.ts`.** It exports one
   value, `<Module>Module`, a plain record of Layers. `layer` is the module's
   dispatchers with the live adapters its handlers need provided. The runs
   module adds `engine`, what a process that runs the workflow engine adds
   inside it (decision 4). `events`, the module's event subscriptions, joins
   the record with the events task.
2. **A module provides the modules it needs** with
   `Layer.provide(OtherModule.layer)`, which keeps that a private import;
   `Layer.provideMerge` would re-export it. `architecture.yaml` lets a
   `module.ts` name its own module, the platform and effect, and lets only
   another `module.ts`, a `platform.ts` and tests import it. No module needs
   another yet, so the allowance for another module's `module.ts` joins its
   allowlist with the first that does: the conformance check refuses an
   allowance nothing imports through.
3. **Handler maps provide nothing.** They bind each message to its handler
   and declare the dispatcher; `module.ts` provides what the handlers need.
4. **A service that differs between roots is the root's to provide**, as the
   reference's billing gateway is. For runs that is the engine and its SQL
   client over a `state.db` (`EngineLive`, or `EngineAt` for a rehearsal's
   scratch), the runtime of the flows the root loaded (`RuntimeLayer`), the
   event bus and the platform. The runtime reads the runs' store itself, so
   it needs only the engine. A flow's workflow (`flowLayer`) takes its runs'
   steps through the runs' dispatchers, which the root provides it from the
   module list. The module ships no fake variant of itself.
5. **One list of modules.** `src/interface/application-modules.ts` merges
   every module's slots, and the CLI's `main.ts`, the daemon's server, the
   `*.main.ts` roots and the tests' engine harness (`test/sdk-fakes.ts`'s
   `engineOver`) merge it. A module added there is wired everywhere.
6. **The roots reach a module only through `platform.ts`**, which publishes
   `<Module>Module` in place of the dispatchers' live Layers (ADR 7).

## Consequences

- `AppLive` is `applicationModules.layer` over the CLI's own services, and
  each engine a root builds is `applicationModules.engine` and the root's
  flows over its runtime and its engine, with no order of a module's
  internals to keep.
- One event bus per process: the CLI's, which the engine's commands now
  dispatch on too, where the runs module had brought a bus of its own.
  Nothing subscribes yet; the events task adds the subscriptions.
- A root that runs a trigger itself (`run`, `rehearse`) reads whether a run
  is running through `RunsQueries` (`withRepo` in `repo-runtime.ts`), since
  the runs' store is no longer in its context.
- A test that drives the runs' handlers directly builds the stores beside
  the module (`StateAt` in `test/sdk-fakes.ts`); the stores are the same
  Layer values, so Effect builds them once.
