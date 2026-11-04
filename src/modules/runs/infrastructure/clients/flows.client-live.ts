// A repo's flows as the daemon (or `chernabog run`) loaded them from its
// trusted .chernabog/: each run with its persona's services, and Runs, what
// this machine's runs say of a run, for triggers that leave alone a pull
// request a run owns.

import {
  describeError,
  isSetupError,
  Markers,
  Run,
  Settings,
  triggerOf,
  type TriggerServices,
} from "@chernabog/core";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { FlowsClient, type MarkerLease } from "../../domain/ports/clients/flows.client.ts";
import { FlowFailed, PersonaNotReady } from "../../domain/run/run.errors.ts";
import { RunSpecifications } from "../../domain/run/run.specification.ts";
import { RunsRepository } from "../../domain/run/runs.repository.ts";
import {
  firstPullRequest,
  type FlowRef,
  type ValidityQuestion,
} from "../../domain/run/work-item.value-object.ts";
import { MarkerUnreleasable } from "../../domain/run-marker/run-marker.errors.ts";
import { type LeaseState } from "../../domain/schedule/lease.value-object.ts";
import { type FlowHandle, flowSettingsFor } from "../runtime/engine.ts";
import { type FlowRegistry, handleOf, withRepoOver } from "../runtime/flow-registry.ts";

// The runs as the runtime reads them, from their store.
const withRepo = withRepoOver((runId: string) =>
  RunsRepository.use((runs) => runs.findOne(RunSpecifications.withId(RunId.make(runId)))).pipe(
    Effect.map(Option.map((run) => run.status === "running")),
  ),
);

// A setup error says itself, fix included; anything else is the flow failing.
const failed = <E>(error: E): FlowFailed | PersonaNotReady => {
  if (isSetupError(error)) {
    return new PersonaNotReady({ message: error.message });
  }

  return new FlowFailed({ message: describeError(error) });
};

// A check that fails says why: a Skip by its reason, anything else as failed says it.
const checkFailed = <E>(error: E): FlowFailed | PersonaNotReady => {
  if (Predicate.isTagged(error, "Skip") && Predicate.hasProperty(error, "reason")) {
    return new FlowFailed({ message: String(error.reason) });
  }

  return failed(error);
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

// How long a flow's stillValid may take before the check counts as failed.
const STILL_VALID_TIMEOUT = Duration.minutes(1);

// How long a marker's release may take before it counts as failed.
const RELEASE_TIMEOUT = Duration.minutes(1);

// How long reading or renewing a lease may take before it counts as failed.
const LEASE_TIMEOUT = Duration.minutes(1);

// What a marker's lease reported, as the runs' domain has it.
const leaseState = (report: Markers.LeaseReport): LeaseState => {
  if (report.status === "held") {
    return {
      status: "held",
      expiresAt: Option.fromUndefinedOr(report.expiresAt),
      renewedAt: Option.fromUndefinedOr(report.renewedAt),
    };
  }

  return report;
};

export type FlowsClientOptions = {
  readonly stillValidTimeout?: Duration.Input;
};

// The marker `name`, if known: the SDK's, or the loaded flow's.
const findMarker = (handle: Option.Option<FlowHandle>, name: string) =>
  Option.orElse(Markers.find(Markers.builtIn, name), () =>
    Option.flatMap(handle, (loaded) => Markers.find(loaded.flow.markers ?? [], name)),
  );

// The marker `name`: the SDK's, or the loaded flow's; why there is none.
const markerNamed = (
  handle: Option.Option<FlowHandle>,
  flow: FlowRef,
  name: string,
): Effect.Effect<Markers.Marker, FlowFailed | MarkerUnreleasable> =>
  Option.match(findMarker(handle, name), {
    onSome: Effect.succeed,
    onNone: () =>
      Option.match(handle, {
        // The flow may load again, as a paused or untrusted repo's does.
        onNone: () =>
          Effect.fail(new FlowFailed({ message: `${flow.repo}/${flow.flow} isn't loaded` })),
        onSome: () =>
          Effect.fail(
            new MarkerUnreleasable({
              message: `${flow.flow} no longer defines marker ${name}`,
            }),
          ),
      }),
  });

// The persona's services for the repo, whether or not its flows loaded.
const servicesOf = (registry: FlowRegistry, flow: FlowRef) =>
  Option.match(registry.services(flow.repo, flow.persona), {
    onNone: () =>
      Effect.fail(
        new FlowFailed({
          message: `${flow.repo} has no services as ${Option.getOrElse(flow.persona, () => "the implicit persona")}`,
        }),
      ),
    onSome: (build) =>
      build.pipe(Effect.mapError((error) => new PersonaNotReady({ message: error.message }))),
  });

// A release's failure: arguments that no longer fit can't be retried.
const releaseFailed = <E>(error: E): FlowFailed | PersonaNotReady | MarkerUnreleasable => {
  if (Predicate.isTagged(error, "ArgumentsChanged") && Predicate.hasProperty(error, "message")) {
    return new MarkerUnreleasable({ message: String(error.message) });
  }

  return failed(error);
};

// The run a flow's stillValid asks about, as the SDK's Run service has it.
const runInfo = (flow: FlowRef, question: ValidityQuestion) =>
  Run.of({
    flow: flow.flow,
    runId: question.runId,
    executionId: question.executionId,
    item: question.item,
    subjects: question.subjects,
    ...Option.match(firstPullRequest(question.subjects), {
      onNone: () => ({}),
      onSome: (pullRequest) => ({ pullRequest }),
    }),
  });

export const FlowsClientLive = (registry: FlowRegistry, options: FlowsClientOptions = {}) =>
  Layer.effect(
    FlowsClient,
    Effect.gen(function* () {
      const runs = yield* Effect.context<Effect.Services<ReturnType<typeof withRepo>>>();
      const personaServices = (flow: FlowRef) => servicesOf(registry, flow);

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
            // The flow's settings, as the persona runs it, beside the persona's services.
            onSome: ([handle, build]) =>
              Effect.map(build, (services) => ({
                handle,
                services: Context.add(
                  services,
                  Settings.FlowSettings,
                  flowSettingsFor(handle, flow.persona),
                ),
              })).pipe(Effect.mapError((error) => new PersonaNotReady({ message: error.message }))),
          },
        );

      return FlowsClient.of({
        trigger: (flow) =>
          Effect.gen(function* () {
            const { handle, services } = yield* loaded(flow);

            return yield* withRepo(services, triggerOf(handle.flow)).pipe(Effect.mapError(failed));
          }).pipe(Effect.provideContext(runs)),
        find: (flow, key) =>
          Effect.gen(function* () {
            const { handle, services } = yield* loaded(flow);

            return yield* Option.match(Option.fromUndefinedOr(handle.flow.item), {
              onNone: () => Effect.succeedNone,
              onSome: (find) => withRepo(services, find(key)).pipe(Effect.mapError(failed)),
            });
          }).pipe(Effect.provideContext(runs)),
        stillValid: (flow, question) =>
          Effect.gen(function* () {
            const { handle, services } = yield* loaded(flow);

            const timeout = Duration.fromInputUnsafe(
              options.stillValidTimeout ?? STILL_VALID_TIMEOUT,
            );

            return yield* Option.match(Option.fromUndefinedOr(handle.flow.stillValid), {
              onNone: () => Effect.succeedNone,
              onSome: (check) =>
                withRepo(
                  Context.add(services, Run, runInfo(flow, question)),
                  check(question.item),
                ).pipe(
                  Effect.mapError(checkFailed),
                  Effect.timeoutOrElse({
                    duration: timeout,
                    orElse: () =>
                      Effect.fail(
                        new FlowFailed({
                          message: `stillValid timed out after ${Duration.format(timeout)}`,
                        }),
                      ),
                  }),
                  Effect.asSome,
                ),
            });
          }).pipe(Effect.provideContext(runs)),
        releaseMarker: (flow, question, name, args) =>
          Effect.gen(function* () {
            const marker = yield* markerNamed(handleOf(registry.handles, flow), flow, name);
            const services = yield* personaServices(flow);

            yield* withRepo(
              Context.add(services, Run, runInfo(flow, question)),
              marker.releaseJson(args),
            ).pipe(
              Effect.mapError(releaseFailed),
              Effect.timeoutOrElse({
                duration: RELEASE_TIMEOUT,
                orElse: () =>
                  Effect.fail(
                    new FlowFailed({
                      message: `releasing ${name} timed out after ${Duration.format(RELEASE_TIMEOUT)}`,
                    }),
                  ),
              }),
            );
          }).pipe(Effect.provideContext(runs)),
        markerLease: (flow, question, name, args, renew) =>
          Effect.gen(function* () {
            const leaseJson = Option.flatMapNullishOr(
              findMarker(handleOf(registry.handles, flow), name),
              (marker) => marker.leaseJson,
            );

            if (Option.isNone(leaseJson)) {
              return Option.none<MarkerLease>();
            }

            const services = yield* personaServices(flow);

            return yield* withRepo(
              Context.add(services, Run, runInfo(flow, question)),
              leaseJson.value(args, renew),
            ).pipe(
              Effect.map(({ on, report }) => Option.some({ on, state: leaseState(report) })),
              // Arguments that no longer fit are no lease it can still renew;
              // what the hold is left with is its release's to say.
              Effect.catchIf(
                (error) => Predicate.isTagged(error, "ArgumentsChanged"),
                () => Effect.succeedNone,
              ),
              Effect.mapError(failed),
              Effect.timeoutOrElse({
                duration: LEASE_TIMEOUT,
                orElse: () =>
                  Effect.fail(
                    new FlowFailed({
                      message: `the lease of ${name} timed out after ${Duration.format(LEASE_TIMEOUT)}`,
                    }),
                  ),
              }),
            );
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
