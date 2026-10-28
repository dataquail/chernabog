// A repo's flows as the daemon (or `chernabog run`) loaded them from its
// trusted .chernabog/: each run with its persona's services, and Runs, what
// this machine's runs say of a run, for triggers that leave alone a pull
// request a run owns.

import {
  Claims,
  describeError,
  GitHub,
  isSetupError,
  Markers,
  Run,
  Runs,
  type SetupError,
  triggerOf,
  type TriggerServices,
} from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import { type Persona } from "../../../../kernel/persona.value-object.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { FlowsClient } from "../../domain/ports/clients/flows.client.ts";
import { RunsRepository } from "../../domain/ports/repositories/runs.repository.ts";
import { type ReviewRequest } from "../../domain/routing/routing.value-object.ts";
import { FlowFailed, PersonaNotReady } from "../../domain/run/run.errors.ts";
import { type FlowRef, type ValidityQuestion } from "../../domain/run/work-item.value-object.ts";
import { MarkerUnreleasable } from "../../domain/run-marker/run-marker.errors.ts";
import { type LeaseState } from "../../domain/schedule/lease.value-object.ts";
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

// The lease of `runId`'s claim on `item`, as the claim ref has it now.
const leaseOf = (item: string, runId: string) =>
  Claims.holder(item).pipe(
    Effect.map((found): LeaseState => {
      if (Option.isNone(found)) {
        return { status: "released" };
      }

      if (found.value.runId !== runId) {
        return { status: "lost", reason: Claims.describeLoss(item, found) };
      }

      return {
        status: "held",
        expiresAt: Option.fromUndefinedOr(found.value.expiresAt),
        renewedAt: Option.fromUndefinedOr(found.value.renewedAt),
      };
    }),
  );

// Renews the lease of `runId`'s claim on `item` for `ttl` from now.
const renewing = (item: string, runId: string, ttl: Duration.Duration) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const renewal = yield* Claims.renew(item, runId, ttl);

    if (renewal.status === "renewed") {
      return {
        status: "held",
        expiresAt: Option.some(renewal.expiresAt),
        renewedAt: Option.some(now),
      } satisfies LeaseState;
    }

    if (renewal.status === "lost") {
      return {
        status: "lost",
        reason: Claims.describeLoss(item, renewal.holder),
      } satisfies LeaseState;
    }

    return { status: "released" } satisfies LeaseState;
  });

export type FlowsClientOptions = {
  readonly stillValidTimeout?: Duration.Input;
};

// The marker `name`: the SDK's, or the loaded flow's; why there is none.
const markerNamed = (
  handle: Option.Option<FlowHandle>,
  flow: FlowRef,
  name: string,
): Effect.Effect<Markers.Marker, FlowFailed | MarkerUnreleasable> =>
  Option.match(
    Option.orElse(Markers.find(Markers.builtIn, name), () =>
      Option.flatMap(handle, (loaded) => Markers.find(loaded.flow.markers ?? [], name)),
    ),
    {
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
    },
  );

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
    ...Option.match(question.pullRequest, {
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
        lease: (flow, question, item, renew) =>
          Effect.gen(function* () {
            const services = yield* personaServices(flow);

            const asked = Option.match(renew, {
              onNone: () => leaseOf(item, question.runId),
              onSome: (ttl) => renewing(item, question.runId, ttl),
            });

            return yield* withRepo(Context.add(services, Run, runInfo(flow, question)), asked).pipe(
              Effect.mapError(failed),
              Effect.timeoutOrElse({
                duration: LEASE_TIMEOUT,
                orElse: () =>
                  Effect.fail(
                    new FlowFailed({
                      message: `the lease on ${item} timed out after ${Duration.format(LEASE_TIMEOUT)}`,
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
        reviewRequests: (flow) =>
          Effect.gen(function* () {
            const { services } = yield* loaded(flow);

            const pulls = yield* withRepo(
              services,
              GitHub.use((github) => github.openPullRequests),
            );

            return pulls.map((pull): ReviewRequest => ({
              number: pull.number,
              requestedReviewers: pull.requestedReviewers,
            }));
          }).pipe(
            Effect.orElseSucceed((): ReadonlyArray<ReviewRequest> => []),
            Effect.provideContext(runs),
          ),
      });
    }),
  );
