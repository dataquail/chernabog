import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type FlowFailed, type PersonaNotReady } from "../../run/run.errors.ts";
import { type FlowRef, type WorkItem } from "../../run/work-item.value-object.ts";

// A repo's flows, as loaded from its trusted .chernabog/, each run with its
// persona's services: the work its trigger finds, an item it didn't report,
// and whether its gate lets a run start. Each fails with PersonaNotReady when
// the persona's services can't be built, or the flow asks for one it can't have.
export type FlowsClientService = {
  readonly trigger: (
    flow: FlowRef,
  ) => Effect.Effect<ReadonlyArray<WorkItem>, FlowFailed | PersonaNotReady>;
  // The item a person names by its key, when the flow can find one; none when
  // it can't, or has no way to look one up.
  readonly find: (
    flow: FlowRef,
    key: string,
  ) => Effect.Effect<Option.Option<WorkItem>, FlowFailed | PersonaNotReady>;
  // Why the flow's gate holds its runs back, if it does.
  readonly gate: (flow: FlowRef) => Effect.Effect<Option.Option<string>>;
};

export class FlowsClient extends Context.Service<FlowsClient, FlowsClientService>()(
  "FlowsClient",
) {}
