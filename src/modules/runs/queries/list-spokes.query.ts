import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";

// The ending the hub meant for a spoke, as a cancel would be asked it: who
// asked, whether to close the run's sessions, and how it ends instead of
// cancelled, and why; none for a cancel. Its JSON is what om_spokes keeps.
export const SpokeEndingView = Schema.Struct({
  by: Schema.String,
  closeSessions: Schema.Boolean,
  endAs: Schema.OptionFromNullOr(
    Schema.Struct({
      ending: Schema.Literals([
        "needs-human",
        "superseded",
        "lost",
        "ended-at-park",
        "interrupted",
        "failed",
      ]),
      reason: Schema.String,
    }),
  ),
});

export type SpokeEndingView = typeof SpokeEndingView.Type;

// A spoke a hub recorded (ADR 23, decision 7): its run, its PID (its process
// group's too) and when the OS said it started, how far its journal was
// folded into state.db, and the ending the hub meant for it, if any.
export class SpokeRecordView extends Schema.Class<
  SpokeRecordView,
  { readonly brand: "SpokeRecordView" }
>("SpokeRecordView")({
  runId: RunId,
  pid: Schema.Finite,
  startedAt: Schema.Option(Schema.String),
  hubPid: Schema.Finite,
  foldedSeq: Schema.Finite,
  ending: Schema.Option(SpokeEndingView),
}) {}

// Every spoke a hub recorded and hasn't forgotten: what a hub that starts
// reaps, those of the hub before it (ADR 23, decision 7).
export const ListSpokesQuery = Query.make("ListSpokesQuery", {
  payload: {},
  success: Schema.Struct({ spokes: Schema.Array(SpokeRecordView) }),
});
