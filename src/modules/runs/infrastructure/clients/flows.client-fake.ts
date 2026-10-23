import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import { FlowsClient } from "../../domain/ports/clients/flows.client.ts";
import { FlowFailed } from "../../domain/run/run.errors.ts";
import { type FlowRef, type WorkItem } from "../../domain/run/work-item.value-object.ts";

// A flow as a test has it: the work its trigger reports (or why it fails),
// the items it finds by key, and why its gate holds runs back, if it does.
export type FakeFlow = {
  readonly items: ReadonlyArray<WorkItem>;
  // Why its trigger fails, when it does.
  readonly fails?: string;
  readonly findable?: ReadonlyArray<WorkItem>;
  readonly gate?: string;
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
        Effect.flatMap(flowOf(flow), (found) =>
          Option.match(Option.fromUndefinedOr(found.fails), {
            onNone: () => Effect.succeed(found.items),
            onSome: (message) => Effect.fail(new FlowFailed({ message })),
          }),
        ),
      find: (flow, key) =>
        Effect.map(flowOf(flow), (found) =>
          Option.fromUndefinedOr((found.findable ?? []).find((item) => item.key === key)),
        ),
      gate: (flow) =>
        flowOf(flow).pipe(
          Effect.map((found) => Option.fromUndefinedOr(found.gate)),
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
    }),
  );
};
