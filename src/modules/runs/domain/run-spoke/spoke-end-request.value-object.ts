import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { EndAs } from "../run/cancelled-run.value-object.ts";
import { type RunStatus } from "../run/run-status.value-object.ts";

// The ending the hub means for a run whose spoke it ends (ADR 23, decisions
// 4 to 7), as a cancel asks it: who asked, whether the run's agent sessions
// are to be closed, and how it ends instead of cancelled (lost, failed past a
// bound, …); none for a cancel. Kept on the spoke's record, so a hub that
// dies before the run has ended finishes it the same way when it restarts.
export const SpokeEndRequest = Schema.Struct({
  by: Schema.String,
  closeSessions: Schema.Boolean,
  endAs: Schema.OptionFromNullOr(EndAs),
});

export type SpokeEndRequest = typeof SpokeEndRequest.Type;

// The run's status once it has ended as asked.
export const endingOf = (request: SpokeEndRequest): RunStatus =>
  Option.match(request.endAs, {
    onNone: (): RunStatus => "cancelled",
    onSome: (endAs) => endAs.ending,
  });
