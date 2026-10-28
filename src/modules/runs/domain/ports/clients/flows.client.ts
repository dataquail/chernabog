import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type ReviewRequest } from "../../routing/routing.value-object.ts";
import { type FlowFailed, type PersonaNotReady } from "../../run/run.errors.ts";
import {
  type FlowRef,
  type ItemValidity,
  type ValidityQuestion,
  type WorkItem,
} from "../../run/work-item.value-object.ts";

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
  // Whether a run's work item is still valid, by the flow's stillValid, run
  // as the persona with a timeout; none for a flow that doesn't say. A check
  // that fails or times out is FlowFailed, never Gone.
  readonly stillValid: (
    flow: FlowRef,
    run: ValidityQuestion,
  ) => Effect.Effect<Option.Option<ItemValidity>, FlowFailed | PersonaNotReady>;
  // Why the flow's gate holds its runs back, if it does.
  readonly gate: (flow: FlowRef) => Effect.Effect<Option.Option<string>>;
  // The repo's open pull requests and whom each asks to review, as the
  // flow's persona reads them; none when they can't be read, since they're
  // only a note.
  readonly reviewRequests: (flow: FlowRef) => Effect.Effect<ReadonlyArray<ReviewRequest>>;
};

export class FlowsClient extends Context.Service<FlowsClient, FlowsClientService>()(
  "FlowsClient",
) {}
