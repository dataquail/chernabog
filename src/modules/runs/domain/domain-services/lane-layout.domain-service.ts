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

import * as Arr from "effect/Array";
import * as Option from "effect/Option";

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

// How deep each lane sits. A cycle, which a flow should never declare, is cut
// where it closes.
const depths = (needs: ReadonlyMap<string, ReadonlyArray<string>>) => {
  const found = new Map<string, number>();

  const depth = (lane: string, seen: ReadonlySet<string>): number => {
    const known = Option.fromUndefinedOr(found.get(lane));

    if (Option.isSome(known)) {
      return known.value;
    }

    const upstream = (needs.get(lane) ?? []).filter((other) => !seen.has(other));
    const next = new Set([...seen, lane]);
    const deepest = Math.max(0, ...upstream.map((other) => depth(other, next)));

    found.set(lane, deepest + 1);

    return deepest + 1;
  };

  for (const lane of needs.keys()) {
    depth(lane, new Set());
  }

  return found;
};

// The lanes there are, in their order, laid out by what `declared` says each
// waited on: only lanes there are count, never the lane itself nor the origin.
const layOut = (
  lanes: ReadonlyArray<string>,
  declared: ReadonlyArray<LaneNeeds>,
  origin: Option.Option<string>,
): LaneLayout => {
  const present = new Set(lanes.filter((lane) => !Option.contains(origin, lane)));
  const ids = Arr.dedupe(lanes).filter((lane) => present.has(lane));

  const needs = new Map<string, ReadonlyArray<string>>(
    ids.map((lane) => [
      lane,
      Arr.dedupe(
        declared
          .filter((entry) => entry.lane === lane)
          .flatMap((entry) => entry.needs)
          .filter((other) => other !== lane && present.has(other)),
      ),
    ]),
  );

  const depth = depths(needs);

  const laid = ids.map((lane): LaidOutLane => ({
    lane,
    needs: needs.get(lane) ?? [],
    column: depth.get(lane) ?? 1,
  }));

  const edges = laid.flatMap((lane): ReadonlyArray<LaneEdge> => {
    if (lane.needs.length === 0) {
      return Option.toArray(Option.map(origin, (from) => ({ from, to: lane.lane })));
    }

    return lane.needs.map((from) => ({ from, to: lane.lane }));
  });

  return { lanes: laid, edges };
};

// The laid-out lanes by column, the origin's (0) first, leaving out a column
// no lane is in.
const columns = (layout: LaneLayout): ReadonlyArray<ReadonlyArray<string>> => {
  const width = Math.max(0, ...layout.lanes.map((lane) => lane.column)) + 1;

  return Arr.makeBy(width, (column) =>
    layout.lanes.filter((lane) => lane.column === column).map((lane) => lane.lane),
  ).filter((column) => column.length > 0);
};

export const LaneLayouts = { layOut, columns } as const;
