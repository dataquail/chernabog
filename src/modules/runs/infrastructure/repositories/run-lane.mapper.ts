// A lane as om_lanes stores it: what it needs as a JSON array.

import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunLaneEntity } from "../../domain/run/run-lane.entity.ts";
import { type ColumnMap } from "./criteria-to-sql.ts";

const Needs = Schema.fromJsonString(Schema.Array(Schema.String));

export const LaneColumns = Schema.Struct({
  run_id: Schema.String,
  lane: Schema.String,
  needs: Needs,
});

export const toEntity = (row: typeof LaneColumns.Type) =>
  RunLaneEntity.make({ runId: RunId.make(row.run_id), lane: row.lane, needs: row.needs });

// What a lane needs, as its column holds it.
export const needsColumn = (lane: RunLaneEntity) => Schema.encodeSync(Needs)(lane.needs);

// Each field of a lane, as the om_lanes column a spec's WHERE names.
export const laneColumns: ColumnMap = { runId: "run_id", lane: "lane", needs: "needs" };
