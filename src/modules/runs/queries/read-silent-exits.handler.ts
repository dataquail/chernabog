import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { RunEndingRow } from "../storage/run-ending.schema.ts";
import { type ReadSilentExitsPayload } from "./read-silent-exits.query.ts";

// The silent exits in a row, from the endings of the earlier runs of an
// item, newest first.
const inARow = (endings: ReadonlyArray<RunEndingRow>) => {
  for (const ending of endings) {
    if (Option.isSome(ending.silent_exits)) {
      return ending.silent_exits.value;
    }

    if (ending.status !== "interrupted") {
      return 0;
    }
  }

  return 0;
};

export const readSilentExitsHandler = Effect.fn("readSilentExitsHandler")(function* ({
  runId,
}: ReadSilentExitsPayload) {
  const sql = yield* SqlClient.SqlClient;

  // Each earlier run of the item has the count as it stood when it ended, so
  // the newest that has one says it.
  const endings = yield* sql`SELECT earlier.status, earlier.silent_exits
    FROM om_runs AS earlier JOIN om_runs AS this ON this.id = ${runId}
    WHERE earlier.id != this.id
      AND earlier.repo = this.repo
      AND earlier.persona IS this.persona
      AND earlier.flow = this.flow
      AND earlier.item_key = this.item_key
      AND earlier.finished_at IS NOT NULL
      AND earlier.started_at <= this.started_at
    ORDER BY earlier.started_at DESC, earlier.rowid DESC`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RunEndingRow))),
    Effect.orDie,
  );

  return { silentExits: inARow(endings) };
});
