// How lines of work that run beside one another lay out, as a run's page and
// the TUI draw them: a forEach's lanes on its plan, and a run's lanes in its
// history graph. A domain service, since it reads no aggregate: it takes the
// lanes there are and the lanes each one waited on (its `needs`).
//
// A lane's column is how deep it sits: what the lanes hang off (the origin,
// such as the run's own line or the forEach's node) at 0, the lanes that
// waited on nothing at 1, those that waited on them one past the deepest of
// those, and so on. Every lane that waited on no other lane hangs off the
// origin, when there is one.

import type * as Option from "effect/Option";

// That `lane` waited on `needs` before it started, as its flow declared it.
export type LaneNeeds = { readonly lane: string; readonly needs: ReadonlyArray<string> };

// An arrow from a lane, or the origin, to a lane that waited on it.
export type LaneEdge = { readonly from: string; readonly to: string };

// A lane where it sits: what it waited on, of the lanes there are, and its column.
export type LaidOutLane = {
  readonly lane: string;
  readonly needs: ReadonlyArray<string>;
  readonly column: number;
};

export type LaneLayout = {
  readonly lanes: ReadonlyArray<LaidOutLane>;
  readonly edges: ReadonlyArray<LaneEdge>;
};

// Not yet: no lanes laid out.
const layOut = (
  _lanes: ReadonlyArray<string>,
  _declared: ReadonlyArray<LaneNeeds>,
  _origin: Option.Option<string>,
): LaneLayout => ({ lanes: [], edges: [] });

const columns = (_layout: LaneLayout): ReadonlyArray<ReadonlyArray<string>> => [];

export const LaneLayouts = { layOut, columns } as const;
