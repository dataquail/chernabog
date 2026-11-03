// A run's steps as a graph, the way its page draws them: one lane per line
// of work that runs beside the others, each lane's steps in the order they
// started, and arrows from a lane to the lanes that waited on it.
//
// A step named `<name>#<id>` is in lane `<id>` (the epic names a task's steps
// `implement#task-284`); a step with no `#` is on the run's own line, MAIN.
// A lane's column is how deep it sits: the run's line first, then the lanes
// that waited on nothing, then those that waited on them, and so on. Every
// lane that waited on no other lane hangs off the run's line.
//
// A step's end is its own record of it when the daemon kept one; for a run
// from before it did, a step ended when the next one in its lane started; a
// lane's last step's end is unknown once the run has ended, since a lane can
// sit idle long after its last step.
//
// A run that resumes enters the step it was in again, and the history keeps
// each entry: those are one step, from its first entry.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

export const MAIN = "";

export type StepOutcome = "ok" | "failed";

// A step as the run's history records it.
export type StepRecord = {
  readonly step: string;
  readonly enteredAt: string;
  readonly finishedAt: Option.Option<string>;
  readonly outcome: Option.Option<StepOutcome>;
};

// That `lane` waited on `needs` before it started.
export type LaneNeeds = { readonly lane: string; readonly needs: ReadonlyArray<string> };

// What a step or a lane came to: an outcome the daemon recorded, that it's
// still going, or that it ended with no outcome kept.
export type NodeState = "ok" | "failed" | "running" | "ended";

export type StepNode = {
  // Its whole name, which its log and its page are found by.
  readonly step: string;
  // Its name without its lane.
  readonly label: string;
  readonly lane: string;
  readonly startedAt: number;
  readonly endedAt: Option.Option<number>;
  readonly state: NodeState;
};

export type Lane = {
  readonly id: string;
  readonly label: string;
  readonly steps: ReadonlyArray<StepNode>;
  readonly needs: ReadonlyArray<string>;
  readonly column: number;
  readonly startedAt: number;
  readonly endedAt: Option.Option<number>;
  readonly state: NodeState;
};

export type Edge = { readonly from: string; readonly to: string };

export type RunGraph = {
  readonly lanes: ReadonlyArray<Lane>;
  readonly columns: ReadonlyArray<ReadonlyArray<Lane>>;
  readonly edges: ReadonlyArray<Edge>;
  // Whether any step runs beside another: false for a run on one line.
  readonly parallel: boolean;
};

export type RunFacts = {
  readonly running: boolean;
  readonly finishedAt: Option.Option<string>;
};

// The lane a step is in, and its name without it.
export const splitStep = (step: string) => {
  const at = step.indexOf("#");

  if (at < 0) {
    return { label: step, lane: MAIN };
  }

  return { label: step.slice(0, at), lane: step.slice(at + 1) };
};

export const laneLabel = (lane: string) => {
  if (lane === MAIN) {
    return "run";
  }

  return lane;
};

const time = (iso: string) => Date.parse(iso);

// A step's end and state, by what follows it in its lane and how the run is.
const node = (record: StepRecord, next: Option.Option<StepRecord>, run: RunFacts): StepNode => {
  const { label, lane } = splitStep(record.step);
  const started = time(record.enteredAt);
  const kept = Option.map(record.finishedAt, time);

  const base = { step: record.step, label, lane, startedAt: started };

  if (Option.isSome(record.outcome)) {
    return { ...base, endedAt: kept, state: record.outcome.value };
  }

  if (Option.isSome(kept)) {
    return { ...base, endedAt: kept, state: "ended" };
  }

  if (Option.isSome(next)) {
    return { ...base, endedAt: Option.some(time(next.value.enteredAt)), state: "ended" };
  }

  if (run.running) {
    return { ...base, endedAt: Option.none(), state: "running" };
  }

  return { ...base, endedAt: Option.none(), state: "ended" };
};

// A lane comes to failed if a step failed, running if one still runs, ok
// once every step is, else ended.
const laneState = (steps: ReadonlyArray<StepNode>): NodeState => {
  if (steps.some((step) => step.state === "failed")) {
    return "failed";
  }

  if (steps.some((step) => step.state === "running")) {
    return "running";
  }

  if (steps.length > 0 && steps.every((step) => step.state === "ok")) {
    return "ok";
  }

  return "ended";
};

// A lane's end: its last step's, when that's known; none while it runs.
const latest = (steps: ReadonlyArray<StepNode>) => {
  if (steps.some((step) => step.state === "running")) {
    return Option.none<number>();
  }

  return Arr.match(
    steps.flatMap((step) => Option.toArray(step.endedAt)),
    {
      onEmpty: () => Option.none<number>(),
      onNonEmpty: (ends) => Option.some(Arr.max(ends, Order.Number)),
    },
  );
};

const byStart = Order.mapInput(
  Order.Number,
  (step: { readonly startedAt: number }) => step.startedAt,
);

// How deep each lane sits: the run's line at 0, a lane that waited on nothing
// at 1, one that waited on others one past the deepest of them. A cycle,
// which a flow should never declare, is cut where it closes.
const depths = (needs: ReadonlyMap<string, ReadonlyArray<string>>) => {
  const found = new Map<string, number>([[MAIN, 0]]);

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

export const runGraph = (
  records: ReadonlyArray<StepRecord>,
  declared: ReadonlyArray<LaneNeeds>,
  run: RunFacts,
): RunGraph => {
  const ordered = Arr.sort(
    records,
    Order.mapInput(Order.Number, (record: StepRecord) => time(record.enteredAt)),
  );

  // Each step once, at its first entry; what the daemon recorded of its end
  // comes from whichever entry kept it.
  const once = Arr.dedupeWith(ordered, (first, again) => first.step === again.step).map(
    (first): StepRecord => {
      const entries = ordered.filter((record) => record.step === first.step);

      return {
        ...first,
        finishedAt: Arr.findFirst(entries, (entry) => Option.isSome(entry.finishedAt)).pipe(
          Option.flatMap((entry) => entry.finishedAt),
        ),
        outcome: Arr.findFirst(entries, (entry) => Option.isSome(entry.outcome)).pipe(
          Option.flatMap((entry) => entry.outcome),
        ),
      };
    },
  );

  const grouped = Arr.groupBy(once, (record) => splitStep(record.step).lane);

  const lanesWithSteps = Object.keys(grouped);
  const known = new Set(lanesWithSteps);

  // Only what the lanes it names are, and never the run's own line.
  const needs = new Map<string, ReadonlyArray<string>>(
    lanesWithSteps
      .filter((lane) => lane !== MAIN)
      .map((lane) => [
        lane,
        Arr.dedupe(
          declared
            .filter((entry) => entry.lane === lane)
            .flatMap((entry) => entry.needs)
            .filter((other) => other !== lane && other !== MAIN && known.has(other)),
        ),
      ]),
  );

  const depth = depths(needs);

  const lanes = Arr.sort(
    lanesWithSteps.map((id): Lane => {
      const ofLane = grouped[id] ?? [];

      const steps = ofLane.map((record, index) =>
        node(record, Option.fromUndefinedOr(ofLane[index + 1]), run),
      );

      return {
        id,
        label: laneLabel(id),
        steps,
        needs: needs.get(id) ?? [],
        column: depth.get(id) ?? 1,
        startedAt: Math.min(...steps.map((step) => step.startedAt)),
        endedAt: latest(steps),
        state: laneState(steps),
      };
    }),
    byStart,
  );

  const width = Math.max(0, ...lanes.map((lane) => lane.column)) + 1;

  const columns = Arr.makeBy(width, (column) =>
    lanes.filter((lane) => lane.column === column),
  ).filter((column) => column.length > 0);

  const hasMain = known.has(MAIN);

  const edges = lanes.flatMap((lane): ReadonlyArray<Edge> => {
    if (lane.id === MAIN) {
      return [];
    }

    if (lane.needs.length === 0 && hasMain) {
      return [{ from: MAIN, to: lane.id }];
    }

    return lane.needs.map((from) => ({ from, to: lane.id }));
  });

  return { lanes, columns, edges, parallel: lanes.length > 1 };
};

// How long something took, from its start to its end or `now`, as people say it.
// None for something that ended when no one kept.
export const took = (
  startedAt: number,
  endedAt: Option.Option<number>,
  state: NodeState,
  now: number,
): Option.Option<number> => {
  if (state === "running") {
    return Option.some(now - startedAt);
  }

  return Option.map(endedAt, (ended) => ended - startedAt);
};
