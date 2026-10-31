// The runtime every composition root assembles, in one place (ADR 13): the
// modules from the one list (application-modules.ts), the one event bus their
// commands dispatch on, and the merged CommandBus and QueryBus over every
// module's dispatchers; and, for a root that runs the workflow engine, the
// engine's modules and its flows over the root's runtime and engine. It is the
// reference hexagon's cqrs-runtime.ts, and the only file that calls a bus
// factory.
//
// The roots are the CLI's main.ts (whose AppLive the CLI's commands and the
// daemon run under), the daemon's server and the *.main.ts commands that build
// an engine of their own (run, rehearse, cancel), and the tests' harnesses.

import {
  type Command,
  CommandBus,
  type DispatchTable,
  makeCommandBus,
  makeEventBus,
  makeQueryBus,
  mergeDispatchTables,
  type Query,
  QueryBus,
} from "@effect-server-utils/cqrs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { type FlowRegistry, runEventSpanAttributes } from "../modules/runs/runs.platform.ts";
import { FileStoresUnitOfWork } from "../platform/unit-of-work.ts";
import { applicationModules } from "./application-modules.ts";

// One side of a slice of the buses: the groups it declares, and the
// dispatchers that answer them, as the tables a bus routes by.
type Side<Group, R> = {
  readonly groups: ReadonlyArray<Group>;
  readonly tables: Effect.Effect<ReadonlyArray<DispatchTable>, never, R>;
};

// One CommandBus and one QueryBus over the dispatchers given, for an adapter
// that dispatches a message it doesn't name. Each bus declares every group it
// routes, so one whose table doesn't cover them fails to build, at startup:
// two modules answering one tag (DuplicateDispatchTag), or a group nothing
// answers (UnroutableTags). A tag missing at dispatch is MissingHandler.
export const busesOver = <RC, RQ>(routes: {
  readonly commands: Side<Command.AnyGroup, RC>;
  readonly queries: Side<Query.AnyGroup, RQ>;
}) =>
  Layer.mergeAll(
    Layer.effect(
      CommandBus,
      Effect.map(routes.commands.tables, (tables) =>
        makeCommandBus(mergeDispatchTables(...tables), { declaredIn: routes.commands.groups }),
      ),
    ),
    Layer.effect(
      QueryBus,
      Effect.map(routes.queries.tables, (tables) =>
        makeQueryBus(mergeDispatchTables(...tables), { declaredIn: routes.queries.groups }),
      ),
    ),
  );

// Two slices of one side, as one.
const both = <Group, RA, RB>(a: Side<Group, RA>, b: Side<Group, RB>) => ({
  groups: [...a.groups, ...b.groups],
  tables: Effect.zipWith(a.tables, b.tables, (first, second) => [...first, ...second]),
});

// One event bus per process, which every module's commands dispatch on, with
// what the runs' events say on their spans.
const EventBusLive = makeEventBus({ spanAttributes: runEventSpanAttributes });

// What every process has: each module's dispatchers, the buses over them, the
// event bus and the unit of work the commands over files declare. What else
// differs between roots (the platform, GitHub, a person to ask) is the root's.
export const ApplicationLive = Layer.mergeAll(
  applicationModules.layer,
  busesOver(applicationModules.routes).pipe(Layer.provide(applicationModules.layer)),
).pipe(Layer.provideMerge(Layer.mergeAll(EventBusLive, FileStoresUnitOfWork)));

// Every module's slice of the buses, the engine's included.
const everyRoute = {
  commands: both(applicationModules.routes.commands, applicationModules.engineRoutes.commands),
  queries: both(applicationModules.routes.queries, applicationModules.engineRoutes.queries),
};

// What a process that runs the workflow engine adds, inside ApplicationLive:
// the modules' engine slot, the buses over every module (the engine's
// dispatchers now among them), and the flows the root loaded, which take
// their runs' steps through the modules, over the runtime of the root's
// registry and the engine it chose (EngineLive, or EngineAt for a scratch).
// A root that loads no flow (cancel) passes none, so the flows' types default
// to adding nothing.
export const engineRuntime = <
  EngineOut,
  EngineError,
  EngineIn,
  A = never,
  E = never,
  R = never,
>(options: {
  readonly registry: FlowRegistry;
  readonly flows: ReadonlyArray<Layer.Layer<A, E, R>>;
  readonly engine: Layer.Layer<EngineOut, EngineError, EngineIn>;
}) => {
  const modules = applicationModules.engine;

  return Layer.mergeAll(
    modules,
    busesOver(everyRoute).pipe(Layer.provide(modules)),
    ...options.flows.map((flow) => flow.pipe(Layer.provide(modules))),
  ).pipe(
    Layer.provide(applicationModules.runtime(options.registry)),
    Layer.provideMerge(options.engine),
  );
};
