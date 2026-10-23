// A repo's flows as the daemon (or `chernabog run`) loaded them from its
// trusted .chernabog/: each run with its persona's services, and Runs, what
// this machine's runs say of a run, for triggers that leave alone a pull
// request a run owns.

import {
  describeError,
  isSetupError,
  Runs,
  type SetupError,
  type TriggerServices,
} from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import { type Persona } from "../../../../kernel/persona.value-object.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { FlowsClient } from "../../domain/ports/clients/flows.client.ts";
import { RunsRepository } from "../../domain/ports/repositories/runs.repository.ts";
import { FlowFailed, PersonaNotReady } from "../../domain/run/run.errors.ts";
import { type FlowRef } from "../../domain/run/work-item.value-object.ts";
import { capturing, type FlowHandle, surfaceSetup } from "../runtime/engine.ts";

// Whether a run is still running, none for a run this machine doesn't know.
const capturingRuns = capturing((runId: string) =>
  RunsRepository.use((runs) => runs.findOne(RunId.make(runId))).pipe(
    Effect.map(Option.map((run) => run.status === "running")),
  ),
);

// Runs a flow's trigger (or gate) with the repo's services, and Runs: what
// this machine's runs say of a run, for triggers that leave alone a pull
// request a run owns. A setup error raised by a service the flow asked for,
// such as ReviewerSeat, comes back as a failure.
export const withRepo = <A, E, R>(context: Context.Context<R>, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const isActive = yield* capturingRuns;

    return yield* Effect.provideContext(effect, Context.add(context, Runs, Runs.of({ isActive })));
  }).pipe(surfaceSetup);

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

// A setup error says itself, fix included; anything else is the flow failing.
const failed = <E>(error: E): FlowFailed | PersonaNotReady => {
  if (isSetupError(error)) {
    return new PersonaNotReady({ message: error.message });
  }

  return new FlowFailed({ message: describeError(error) });
};

// The gate's Skip is its own reason, as is a setup error; anything else is
// the gate failing.
const gateReason = <E>(failure: E) => {
  if (Predicate.isTagged(failure, "Skip") && Predicate.hasProperty(failure, "reason")) {
    return String(failure.reason);
  }

  if (isSetupError(failure)) {
    return failure.message;
  }

  return `gate failed: ${describeError(failure)}`;
};

export const FlowsClientLive = (registry: FlowRegistry) =>
  Layer.effect(
    FlowsClient,
    Effect.gen(function* () {
      const runs = yield* Effect.context<Effect.Services<ReturnType<typeof withRepo>>>();

      // The flow's handle and its persona's services, or why there are none.
      const loaded = (
        flow: FlowRef,
      ): Effect.Effect<
        { readonly handle: FlowHandle; readonly services: Context.Context<TriggerServices> },
        FlowFailed | PersonaNotReady
      > =>
        Option.match(
          Option.product(
            handleOf(registry.handles, flow),
            registry.services(flow.repo, flow.persona),
          ),
          {
            onNone: () =>
              Effect.fail(
                new FlowFailed({
                  message: `${flow.repo} has no services for ${flow.flow} as ${Option.getOrElse(flow.persona, () => "the implicit persona")}`,
                }),
              ),
            onSome: ([handle, build]) =>
              Effect.map(build, (services) => ({ handle, services })).pipe(
                Effect.mapError((error) => new PersonaNotReady({ message: error.message })),
              ),
          },
        );

      return FlowsClient.of({
        trigger: (flow) =>
          Effect.gen(function* () {
            const { handle, services } = yield* loaded(flow);

            return yield* withRepo(services, handle.flow.trigger).pipe(Effect.mapError(failed));
          }).pipe(Effect.provideContext(runs)),
        find: (flow, key) =>
          Effect.gen(function* () {
            const { handle, services } = yield* loaded(flow);

            return yield* Option.match(Option.fromUndefinedOr(handle.flow.item), {
              onNone: () => Effect.succeedNone,
              onSome: (find) => withRepo(services, find(key)).pipe(Effect.mapError(failed)),
            });
          }).pipe(Effect.provideContext(runs)),
        gate: (flow) =>
          Effect.gen(function* () {
            // A persona that can't act holds its runs back, saying why.
            const found = yield* Effect.result(
              loaded(flow).pipe(Effect.catchTag("FlowFailed", (error) => Effect.die(error))),
            );

            if (Result.isFailure(found)) {
              return Option.some(found.failure.message);
            }

            const { handle, services } = found.success;

            return yield* Option.match(Option.fromUndefinedOr(handle.flow.gate), {
              onNone: () => Effect.succeedNone,
              onSome: (gate) =>
                Effect.result(withRepo(services, gate)).pipe(
                  Effect.map(
                    Result.match({
                      onSuccess: () => Option.none(),
                      onFailure: (failure) => Option.some(gateReason(failure)),
                    }),
                  ),
                ),
            });
          }).pipe(Effect.provideContext(runs)),
      });
    }),
  );
