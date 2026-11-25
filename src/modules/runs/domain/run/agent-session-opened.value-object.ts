import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type SpokeReport } from "./spoke-report.value-object.ts";

// A spoke's report that one of its run's agent calls started or resumed a
// session (ADR 23, decision 3): the adapter, the session's id, and where its
// launch record is (`sessions/interactive/<id>/launch.json`), which holds its
// launcher's handle once a launcher started it, and which a headless session
// never writes; and the files and folders its transcripts grow in, for an
// adapter that says. The hub keeps it for the spoke's life, so ending the
// spoke can close the session by that handle (decision 5), and a session
// whose transcripts grow keeps its spoke from being idle (decision 4). It is
// no runs' command: the hub folds it into nothing in state.db.
export const AgentSessionOpened = Schema.Struct({
  adapter: Schema.String,
  sessionId: Schema.String,
  launch: Schema.String,
  transcripts: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type AgentSessionOpened = typeof AgentSessionOpened.Type;

// Its tag in `spoke_reports`.
export const AGENT_SESSION_OPENED = "AgentSessionOpened";

const OpenedJson = Schema.fromJsonString(AgentSessionOpened);

export const encodeSessionOpened = Schema.encodeSync(OpenedJson);

// The session a report says was opened; none for a report of another tag, or
// one whose payload doesn't read.
export const sessionOpenedIn = (report: SpokeReport): Option.Option<AgentSessionOpened> =>
  Option.flatMap(
    Option.liftPredicate(report, (one) => one.tag === AGENT_SESSION_OPENED),
    (one) => Schema.decodeOption(OpenedJson)(one.payload),
  );
