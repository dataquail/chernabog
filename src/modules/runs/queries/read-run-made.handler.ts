import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { CreatedIssueRow } from "../storage/created-issue.schema.ts";
import { type ReadRunMadePayload, RunMade } from "./read-run-made.query.ts";

// The claim ref's marker, as core's Claims.refMarker names it and the
// arguments it holds: a name and arguments fixed once a release held them
// (docs/adr/0004-core-abi.md).
const CLAIM_REF_MARKER = "chernabog/claim-ref";

const ClaimArgs = Schema.fromJsonString(
  Schema.Struct({ item: Schema.String, runId: Schema.String }),
);

const MarkerArgs = Schema.Struct({ args: Schema.String });

export const readRunMadeHandler = Effect.fn("readRunMadeHandler")(function* ({
  runId,
}: ReadRunMadePayload) {
  const sql = yield* SqlClient.SqlClient;

  // Queries over the runs' own tables: a failure is a bug, not a condition.
  const created =
    yield* sql`SELECT * FROM om_created_issues WHERE run_id = ${runId} ORDER BY rowid`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(CreatedIssueRow))),
      Effect.orDie,
    );

  // Every claim-ref marker the run held, released or not: one its ending let
  // go of is gone already, and one it still held when it stopped is not.
  const markers = yield* sql`SELECT args FROM om_markers
    WHERE run_id = ${runId} AND name = ${CLAIM_REF_MARKER} ORDER BY rowid`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(MarkerArgs))),
    Effect.orDie,
  );

  const claims = markers
    .flatMap((marker) => Option.toArray(Schema.decodeOption(ClaimArgs)(marker.args)))
    .filter((claim) => claim.runId === runId);

  return RunMade.make({
    createdIssues: created.map((row) => row.issue),
    claims: Arr.dedupeWith(claims, (left, right) => left.item === right.item),
  });
});
