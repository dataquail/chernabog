// A repo's flows as the daemon (or `chernabog run`) loaded them from its
// trusted .chernabog/: each run with its persona's services, and Runs, what
// this machine's runs say of a run, for triggers that leave alone a pull
// request a run owns.

import { describeError, type FlowFailure, Runs, type TriggerServices } from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import { capturing, type FlowHandle } from "../../../../engine.ts";
import { type Persona } from "../../../../kernel/persona.value-object.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { FlowsClient } from "../../domain/ports/clients/flows.client.ts";
import { RunsRepository } from "../../domain/ports/repositories/runs.repository.ts";
import { FlowFailed } from "../../domain/run/run.errors.ts";
import { type FlowRef } from "../../domain/run/work-item.value-object.ts";

// Whether a run is still running, none for a run this machine doesn't know.
const capturingRuns = capturing((runId: string) =>
  RunsRepository.use((runs) => runs.findOne(RunId.make(runId))).pipe(
    Effect.map(Option.map((run) => run.status === "running")),
  ),
);

// Runs a flow's trigger (or gate) with the repo's services, and Runs: what
// this machine's runs say of a run, for triggers that leave alone a pull
// request a run owns.
export const withRepo = <A, E, R>(context: Context.Context<R>, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const isActive = yield* capturingRuns;

    return yield* Effect.provideContext(effect, Context.add(context, Runs, Runs.of({ isActive })));
  });

// The flows a process loaded, and the services each persona's runs of them
// use: none for a persona the repo no longer has.
export type FlowRegistry = {
  readonly handles: ReadonlyArray<FlowHandle>;
  readonly services: (
    repo: string,
    persona: Persona,
  ) => Option.Option<Context.Context<TriggerServices>>;
};

// The registry's handle for a flow, if it loaded it.
export const handleOf = (handles: ReadonlyArray<FlowHandle>, flow: FlowRef) =>
  Arr.findFirst(
    handles,
    (handle) => handle.repo.settings.name === flow.repo && handle.name === flow.flow,
  );

const failed = <E>(error: E) => new FlowFailed({ message: describeError(error) });

// The gate's Skip is its own reason; anything else is the gate failing.
const gateReason = (failure: FlowFailure) => {
  if (Predicate.isTagged(failure, "Skip") && Predicate.hasProperty(failure, "reason")) {
    return String(failure.reason);
  }

  return `gate failed: ${describeError(failure)}`;
};

export const FlowsClientLive = (registry: FlowRegistry) =>
  Layer.effect(
    FlowsClient,
    Effect.gen(function* () {
      const runs = yield* Effect.context<Effect.Services<ReturnType<typeof withRepo>>>();

      // The flow's handle and its persona's services, or why there are none.
      const loaded = (flow: FlowRef) =>
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
            onSome: ([handle, services]) => Effect.succeed({ handle, services }),
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
            const { handle, services } = yield* Effect.orDie(loaded(flow));

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
