// A spoke's record as om_spokes stores it: its intended ending as JSON.

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunSpokeRoot } from "../../domain/run-spoke/run-spoke.root.ts";
import { SpokeEndRequest } from "../../domain/run-spoke/spoke-end-request.value-object.ts";
import { type RunSpokeRow } from "../../storage/run-spoke.schema.ts";
import { type ColumnMap } from "./criteria-to-sql.ts";

const EndingJson = Schema.fromJsonString(SpokeEndRequest);
const decodeEnding = Schema.decodeSync(EndingJson);
const encodeEnding = Schema.encodeSync(EndingJson);

export const toRoot = (row: RunSpokeRow) =>
  RunSpokeRoot.make({
    runId: RunId.make(row.run_id),
    pid: row.pid,
    startedAt: row.started_at,
    hubPid: row.hub_pid,
    hubStartedAt: row.hub_started_at,
    foldedSeq: row.folded_seq,
    ending: Option.map(row.ending, decodeEnding),
  });

export const toRow = (spoke: RunSpokeRoot): RunSpokeRow => ({
  run_id: spoke.runId,
  pid: spoke.pid,
  started_at: spoke.startedAt,
  hub_pid: spoke.hubPid,
  hub_started_at: spoke.hubStartedAt,
  folded_seq: spoke.foldedSeq,
  ending: Option.map(spoke.ending, encodeEnding),
});

// Each field of a spoke's record, as the om_spokes column a spec's WHERE names.
export const spokeColumns: ColumnMap = {
  runId: "run_id",
  pid: "pid",
  startedAt: "started_at",
  hubPid: "hub_pid",
  hubStartedAt: "hub_started_at",
  foldedSeq: "folded_seq",
};
