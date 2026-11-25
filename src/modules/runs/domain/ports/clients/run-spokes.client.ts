import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type RunId } from "../../../../../kernel/run-id.id.ts";
import { type EndedSpoke } from "../../run/ended-spoke.value-object.ts";
import { type RunStatus } from "../../run/run-status.value-object.ts";

// The spokes runs execute in, in this process (ADR 23): only a hub has any.
export type RunSpokesClientService = {
  // Ends the run's spoke, if one is live here, for the ending its run is about
  // to take (ADR 23, decision 5): records that ending as the one the hub
  // means for it, so the hub doesn't end the run from the spoke's exit itself;
  // SIGTERM to its process group, then SIGKILL after the grace; and waits for
  // it to exit and for what it reported to be folded into state.db. None when
  // no spoke of the run is live here.
  readonly end: (runId: RunId, ending: RunStatus) => Effect.Effect<Option.Option<EndedSpoke>>;
};

export class RunSpokesClient extends Context.Service<RunSpokesClient, RunSpokesClientService>()(
  "RunSpokesClient",
) {}
