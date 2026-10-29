import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

import { type ReviewRequest } from "../../review-requests/review-requests.value-object.ts";
import { type FlowFailed, type PersonaNotReady } from "../../run/run.errors.ts";
import {
  type FlowRef,
  type ItemValidity,
  type ValidityQuestion,
  type WorkItem,
} from "../../run/work-item.value-object.ts";
import { type MarkerUnreleasable } from "../../run-marker/run-marker.errors.ts";
import { type LeaseState } from "../../schedule/lease.value-object.ts";

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
  // Releases a marker a run held, by the flow's definition of `name` (or the
  // SDK's), with the arguments the hold gave, as the persona with a timeout.
  // MarkerUnreleasable when the loaded flow no longer defines it, or the
  // arguments no longer fit; a flow not loaded, or a release that fails, is
  // FlowFailed, which is worth trying again.
  readonly releaseMarker: (
    flow: FlowRef,
    run: ValidityQuestion,
    name: string,
    args: Schema.Json,
  ) => Effect.Effect<void, FlowFailed | PersonaNotReady | MarkerUnreleasable>;
  // The lease of the run's claim on `item`, as the persona with a timeout:
  // renewed for `renew` from now when given (a compare-and-swap, which fails
  // to another run that took it over first), else only read.
  readonly lease: (
    flow: FlowRef,
    run: ValidityQuestion,
    item: string,
    renew: Option.Option<Duration.Duration>,
  ) => Effect.Effect<LeaseState, FlowFailed | PersonaNotReady>;
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
