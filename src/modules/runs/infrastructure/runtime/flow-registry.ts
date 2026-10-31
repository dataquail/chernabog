// The flows a process loaded, as the runs module's clients and the roots that
// run a trigger themselves share them: the registry a root hands the module,
// a flow's handle in it, and the services a trigger runs with. Kept apart from
// the clients' live adapters so that only the module's wiring names those.

import { Runs, type SetupError, type TriggerServices } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type Persona } from "../../../../kernel/persona.value-object.ts";
import { type FlowRef } from "../../domain/run/work-item.value-object.ts";
import { capturing, type FlowHandle, surfaceSetup } from "./engine.ts";

// The flows a process loaded, and the services each persona's runs of them
// use, which fail with the setup error that stops the persona acting: none
// for a persona the repo no longer has.
export type FlowRegistry = {
  readonly handles: ReadonlyArray<FlowHandle>;
  readonly services: (
    repo: string,
    persona: Persona,
  ) => Option.Option<Effect.Effect<Context.Context<TriggerServices>, SetupError>>;
};

// The registry's handle for a flow, if it loaded it.
export const handleOf = (handles: ReadonlyArray<FlowHandle>, flow: FlowRef) =>
  Arr.findFirst(
    handles,
    (handle) => handle.repo.settings.name === flow.repo && handle.name === flow.flow,
  );

// Whether a run is still running, none for a run this machine doesn't know.
// Runs a flow's trigger (or gate) with the repo's services, and Runs: what
// this machine's runs say of a run, as `isRunning` reads it, for triggers that
// leave alone a pull request a run owns. A setup error raised by a service the
// flow asked for, such as ReviewerSeat, comes back as a failure.
export const withRepoOver = <RR>(
  isRunning: (runId: string) => Effect.Effect<Option.Option<boolean>, never, RR>,
) => {
  const capturingRuns = capturing(isRunning);

  return <A, E, R>(context: Context.Context<R>, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const isActive = yield* capturingRuns;

      return yield* Effect.provideContext(
        effect,
        Context.add(context, Runs, Runs.of({ isActive })),
      );
    }).pipe(surfaceSetup);
};
