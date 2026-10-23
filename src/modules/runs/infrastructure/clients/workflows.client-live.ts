// Runs' workflows in the Effect workflow engine this process runs, journaled
// in state.db: started, polled and resumed through the handle of the flow
// they run, and woken through the durable deferreds they wait on.

import { signalDeferred } from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as DurableDeferred from "effect/workflow/DurableDeferred";

import { type FlowHandle, runLogFor, statusOfExit } from "../../../../engine.ts";
import { WorkflowsClient } from "../../domain/ports/clients/workflows.client.ts";
import { type FlowRef, type WorkItem } from "../../domain/run/work-item.value-object.ts";
import { handleOf } from "./flows.client-live.ts";

const decodeToken = Schema.decodeEffect(DurableDeferred.Token);

// A run's payload: its persona rides in it, so a resumed run acts as the same one.
const payloadOf = (flow: FlowRef, runId: string, item: WorkItem) =>
  Option.match(flow.persona, {
    onNone: () => ({ runId, item }),
    onSome: (login) => ({ runId, item, persona: login }),
  });

export const WorkflowsClientLive = (handles: ReadonlyArray<FlowHandle>) =>
  Layer.effect(
    WorkflowsClient,
    Effect.gen(function* () {
      const engine = yield* Effect.context<
        | Effect.Services<ReturnType<FlowHandle["workflow"]["execute"]>>
        | Effect.Services<ReturnType<typeof runLogFor>>
      >();

      // A flow this process didn't load runs nowhere here.
      const handle = (flow: FlowRef): Effect.Effect<FlowHandle> =>
        Option.match(handleOf(handles, flow), {
          onNone: () => Effect.die(`no workflow for ${flow.repo}/${flow.flow} in this process`),
          onSome: (found) => Effect.succeed(found),
        });

      return WorkflowsClient.of({
        execute: (flow, runId, item) =>
          handle(flow).pipe(
            Effect.flatMap((found) =>
              found.workflow.execute(payloadOf(flow, runId, item), { discard: true }),
            ),
            Effect.provideContext(engine),
          ),
        poll: (flow, executionId) =>
          Option.match(handleOf(handles, flow), {
            onNone: () => Effect.succeedNone,
            onSome: (found) =>
              found.workflow.poll(executionId).pipe(
                Effect.map((result) =>
                  Option.map(
                    Option.filter(result, (polled) => Predicate.isTagged(polled, "Complete")),
                    (complete) => statusOfExit(complete.exit),
                  ),
                ),
              ),
          }).pipe(Effect.provideContext(engine)),
        resume: (flow, executionId) =>
          handle(flow).pipe(
            Effect.flatMap((found) => found.workflow.resume(executionId)),
            Effect.provideContext(engine),
          ),
        wake: (deferred, token) =>
          Effect.gen(function* () {
            yield* DurableDeferred.succeed(signalDeferred(deferred), {
              token: yield* decodeToken(token),
              value: true,
            });
          }).pipe(Effect.orDie, Effect.provideContext(engine)),
        note: (runId, line) =>
          runLogFor(runId).pipe(
            Effect.flatMap((log) => log.log(line)),
            Effect.orDie,
            Effect.provideContext(engine),
          ),
      });
    }),
  );
