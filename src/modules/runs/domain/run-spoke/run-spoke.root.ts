import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { SpokeEndRequest } from "./spoke-end-request.value-object.ts";

// A run's live spoke, as the hub that spawned it records it in state.db
// (`om_spokes`, ADR 23, decision 7), so the next hub can end it if this one
// dies first: the process, which leads its own process group, and its start
// time as the OS reports it, so a reused PID isn't taken for it; the hub's
// own; how far the hub has folded its journal's reports into state.db; and
// the ending the hub means for it, once it does. Written once the spoke is
// spawned, and forgotten once its run has ended.
export class RunSpokeRoot extends Schema.Class<RunSpokeRoot, { readonly brand: "RunSpokeRoot" }>(
  "RunSpokeRoot",
)({
  runId: RunId,
  // The spoke's PID, which is also its process group's id.
  pid: Schema.Finite,
  // When the process started, as `ps` says it; none when the OS didn't say.
  startedAt: Schema.Option(Schema.String),
  hubPid: Schema.Finite,
  hubStartedAt: Schema.Option(Schema.String),
  // The `seq` of the last report folded into state.db; 0 before the first.
  foldedSeq: Schema.Finite,
  ending: Schema.Option(SpokeEndRequest),
}) {}
