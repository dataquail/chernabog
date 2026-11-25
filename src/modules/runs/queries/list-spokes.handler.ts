import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { RunId } from "../../../kernel/run-id.id.ts";
import { RunSpokeRow } from "../storage/run-spoke.schema.ts";
import { SpokeEndingView, SpokeRecordView } from "./list-spokes.query.ts";

const decodeEnding = Schema.decodeUnknownOption(Schema.fromJsonString(SpokeEndingView));

export const listSpokesHandler = Effect.fn("listSpokesHandler")(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The table is the spokes repository's, made when the runs' stores are
  // built; a state.db from before it has none, and so no spoke to reap.
  const rows = yield* sql`SELECT * FROM om_spokes ORDER BY rowid`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RunSpokeRow))),
    Effect.orDie,
  );

  return {
    spokes: rows.map((row) =>
      SpokeRecordView.make({
        runId: RunId.make(row.run_id),
        pid: row.pid,
        startedAt: row.started_at,
        hubPid: row.hub_pid,
        foldedSeq: row.folded_seq,
        ending: Option.flatMap(row.ending, decodeEnding),
      }),
    ),
  };
});
