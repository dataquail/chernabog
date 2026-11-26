import * as Schema from "effect/Schema";

import { RunView } from "./run-view.value-object.ts";
import { WorkItem } from "./work-item.value-object.ts";

// What a hub hands the spoke it starts for a run (ADR 23, decisions 2 and 3):
// the run as the hub recorded it in state.db, its execution attached, and the
// item it is for. A spoke never opens state.db, so what it would read there
// about its own run it reads here; none of it changes for the run afterwards.
// With them, where the hub's session API listens and the run's key, which
// the spoke mints its agent sessions' tokens with (ADR 24); a hub that
// couldn't open the API gives none.
export const SpokeSessionApi = Schema.Struct({ port: Schema.Int, key: Schema.String });

export const SpokeHandOver = Schema.Struct({
  run: RunView,
  item: WorkItem,
  sessionApi: Schema.optionalKey(SpokeSessionApi),
});

export type SpokeHandOver = typeof SpokeHandOver.Type;

// The hand-over as the file the hub writes beside the spoke, JSON.
export const SpokeHandOverJson = Schema.fromJsonString(SpokeHandOver);
