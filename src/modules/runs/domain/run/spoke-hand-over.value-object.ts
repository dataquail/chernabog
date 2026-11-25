import * as Schema from "effect/Schema";

import { RunView } from "./run-view.value-object.ts";
import { WorkItem } from "./work-item.value-object.ts";

// What a hub hands the spoke it starts for a run (ADR 23, decisions 2 and 3):
// the run as the hub recorded it in state.db, its execution attached, and the
// item it is for. A spoke never opens state.db, so what it would read there
// about its own run it reads here; none of it changes for the run afterwards.
export const SpokeHandOver = Schema.Struct({ run: RunView, item: WorkItem });

export type SpokeHandOver = typeof SpokeHandOver.Type;

// The hand-over as the file the hub writes beside the spoke, JSON.
export const SpokeHandOverJson = Schema.fromJsonString(SpokeHandOver);
