import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";

import { FlowsClient } from "../../domain/ports/clients/flows.client.ts";
import { type ReviewRequest } from "../../domain/routing/routing.value-object.ts";
import { FlowFailed, PersonaNotReady } from "../../domain/run/run.errors.ts";
import {
  type FlowRef,
  type ItemValidity,
  type ValidityQuestion,
  type WorkItem,
} from "../../domain/run/work-item.value-object.ts";

// A flow as a test has it: the work its trigger reports (or why it fails),
// the items it finds by key, and why its gate holds runs back, if it does.
export type FakeFlow = {
  readonly items: ReadonlyArray<WorkItem>;
  // Why its trigger fails, when it does.
  readonly fails?: string;
  // Why its persona can't run it here, when it can't.
  readonly notReady?: string;
  readonly findable?: ReadonlyArray<WorkItem>;
  readonly gate?: string;
  // The open pull requests, and whom each asks to review.
  readonly reviewRequests?: ReadonlyArray<ReviewRequest>;
  // What its stillValid answers, if it has one, or why it fails; and the
  // runs it was asked about, which the fake appends to.
  readonly validity?: ItemValidity;
  readonly validityFails?: string;
  readonly asked?: Array<ValidityQuestion>;
};

const keyOf = (flow: FlowRef) => `${flow.repo}/${flow.flow}`;

// Flows by repo/flow; a flow not listed fails as one never loaded.
export const FlowsClientFake = (flows: Readonly<Record<string, FakeFlow>>) => {
  const flowOf = (flow: FlowRef) =>
    Effect.fromOption(Record.get(flows, keyOf(flow))).pipe(
      Effect.mapError(() => new FlowFailed({ message: `no flow ${keyOf(flow)}` })),
    );

  return Layer.succeed(
    FlowsClient,
    FlowsClient.of({
      trigger: (flow) =>
        Effect.flatMap(
          flowOf(flow),
          (found): Effect.Effect<ReadonlyArray<WorkItem>, FlowFailed | PersonaNotReady> => {
            if (Predicate.isNotUndefined(found.notReady)) {
              return Effect.fail(new PersonaNotReady({ message: found.notReady }));
            }

            return Option.match(Option.fromUndefinedOr(found.fails), {
              onNone: () => Effect.succeed(found.items),
              onSome: (message) => Effect.fail(new FlowFailed({ message })),
            });
          },
        ),
      find: (flow, key) =>
        Effect.map(flowOf(flow), (found) =>
          Option.fromUndefinedOr((found.findable ?? []).find((item) => item.key === key)),
        ),
      stillValid: (flow, run) =>
        Effect.flatMap(
          flowOf(flow),
          (found): Effect.Effect<Option.Option<ItemValidity>, FlowFailed> => {
            found.asked?.push(run);

            return Option.match(Option.fromUndefinedOr(found.validityFails), {
              onNone: () => Effect.succeed(Option.fromUndefinedOr(found.validity)),
              onSome: (message) => Effect.fail(new FlowFailed({ message })),
            });
          },
        ),
      gate: (flow) =>
        flowOf(flow).pipe(
          Effect.map((found) => Option.fromUndefinedOr(found.gate)),
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
      reviewRequests: (flow) =>
        flowOf(flow).pipe(
          Effect.map((found): ReadonlyArray<ReviewRequest> => found.reviewRequests ?? []),
          Effect.orElseSucceed((): ReadonlyArray<ReviewRequest> => []),
        ),
    }),
  );
};
