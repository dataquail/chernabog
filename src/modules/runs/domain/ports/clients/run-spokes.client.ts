import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type RunId } from "../../../../../kernel/run-id.id.ts";
import { type EndedSpoke } from "../../run/ended-spoke.value-object.ts";
import { type SpokeEndRequest } from "../../run-spoke/spoke-end-request.value-object.ts";

// The spokes runs execute in, in this process (ADR 23): only a hub has any.
export type RunSpokesClientService = {
  // Ends the run's spoke, if one is live here, for the ending its run is about
  // to take, as it was asked (ADR 23, decision 5): records that ending as the
  // one the hub means for it, on the spoke's record too, so the hub doesn't
  // end the run from the spoke's exit itself, and a hub that dies before the
  // run has ended ends it the same way when it restarts (decision 7);
  // SIGTERM to its process group, then SIGKILL after the grace; and waits for
  // it to exit and for what it reported to be folded into state.db. A spoke
  // asked to end for two endings at once ends for the first, which both hear
  // (`endedFor`). A spoke a hub reaped when it started (decision 7) answers
  // as one it ended. None when no spoke of the run is live here.
  readonly end: (
    runId: RunId,
    request: SpokeEndRequest,
  ) => Effect.Effect<Option.Option<EndedSpoke>>;
  // Forgets a spoke `end` ended: until then `end` answers for it with the
  // ending it was first ended for. The hub forgets it once the run's ending
  // is recorded; a command that ended it and then failed forgets it at once.
  readonly forget: (runId: RunId) => Effect.Effect<void>;
};

export class RunSpokesClient extends Context.Service<RunSpokesClient, RunSpokesClientService>()(
  "RunSpokesClient",
) {}
