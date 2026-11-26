// The epic recipe through the engine, on an in-memory GitHub: an epic of
// tasks, some building on others, implemented as pull requests stacked on the
// branch of the task each builds on; a task still blocked twice over waits;
// and the run parks between rounds, which ends it (ADR 23, decision 2), until
// a layer's pull request changes and Epic.queued offers the epic to a new
// run, which carries on from the epic's waiting record.

import {
  Claims,
  DEFAULT_LABELS,
  Epic,
  type LinkedIssue,
  Plan,
  type PullRequest,
} from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import epic from "../packages/recipes/flows/epic.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { readRunHistoryHandler } from "../src/modules/runs/queries/read-run-history.handler.ts";
import { effect } from "./effect-test.ts";
import {
  type EngineRun,
  type Fake,
  flowTriggered,
  follow,
  item,
  makeFake,
  onEngine,
  repo,
  summaryOf,
  takeUp,
  triggered,
} from "./sdk-fakes.ts";

// The engine runs below take a second or two alone, but under the whole
// suite's load the engine's runner can miss health checks for seconds.
const ENGINE_TIMEOUT = 60_000;

const EPIC = 40;

const working = flowHandle(repo, "epic", epic);

// The epic flow with ship set, so its layers are on the automated path.
const shipping = flowHandle(
  {
    ...repo,
    personas: Arr.map(repo.personas, (persona) => ({ ...persona, shared: { ship: true } })),
  },
  "epic",
  epic,
);

const work = item(`issue-${EPIC}`, { issue: EPIC });

const madeIssue = (number: number, title: string): LinkedIssue => ({
  number,
  title,
  body: "",
  url: `https://github.com/dataquail/demo/issues/${number}`,
  createdAt: "2026-10-21T00:00:00Z",
  labels: [],
  assignees: [],
  state: "open",
});

// An auto task of the epic, blocked by these.
const task = (fake: Fake, number: number, blockedBy: ReadonlyArray<number> = []) => {
  fake.graph.made.set(number, madeIssue(number, `Task ${number}`));
  fake.setLabels(number, [DEFAULT_LABELS.eligible]);
  fake.graph.blockedBy.set(number, [...blockedBy]);
  fake.graph.subIssues.set(EPIC, [...(fake.graph.subIssues.get(EPIC) ?? []), number]);
};

// The epic: #10, then #11 on it; #12 on its own; and #13, which needs both #10 and #12.
const epicFake = () => {
  const fake = makeFake("approve");
  fake.graph.made.set(EPIC, madeIssue(EPIC, "An epic"));
  fake.setLabels(EPIC, [Plan.LABELS.epic]);
  task(fake, 10);
  task(fake, 11, [10]);
  task(fake, 12);
  task(fake, 13, [10, 12]);

  return fake;
};

const pullOf = (fake: Fake, number: number) =>
  Option.fromUndefinedOr(fake.branchPulls.get(Claims.branchFor(number)));

// The base each task's pull request targets.
const bases = (fake: Fake) =>
  Object.fromEntries(
    [...fake.branchPulls.values()].map((pull) => [pull.headRef, pull.baseRef] as const),
  );

// Closes the task, and merges its pull request, as a person merging it would.
const merge = (fake: Fake, number: number) => {
  for (const found of Option.toArray(Option.fromUndefinedOr(fake.graph.made.get(number)))) {
    fake.graph.made.set(number, { ...found, state: "closed" });
  }

  for (const pull of Option.toArray(pullOf(fake, number))) {
    fake.branchPulls.set(pull.headRef, { ...pull, state: "merged" });
  }
};

const statusOf = (fake: Fake) =>
  Option.fromUndefinedOr(
    fake.comments.findLast((comment) => Option.isSome(Epic.statusMarker.read(comment.body))),
  ).pipe(Option.map((comment) => comment.body));

// What the fake looked like when the run parked: each pull request's base, by
// its head, and the epic's status comment.
type Snapshot = { readonly bases: Record<string, string>; readonly status: string };

const NOTHING: Snapshot = { bases: {}, status: "" };

// Runs the epic flow; each time a run ends at its park, records what the
// fake looks like, makes the next change, and takes the epic up in a new run
// from what Epic.queued then offers, as a tick would; until a run ends
// otherwise, or no change is left. The last run, the snapshots, the lanes
// each run declared, in run order, and how each run before the last ended.
const workWith = (
  fake: Fake,
  changes: ReadonlyArray<(fake: Fake) => void>,
  handle: typeof working = working,
) =>
  onEngine(
    handle,
    fake,
    Effect.gen(function* () {
      const snapshots: Array<Snapshot> = [];
      // The lanes each run declared, by lane: a lane waits only on lanes of its own run.
      const lanes: Array<Record<string, ReadonlyArray<string>>> = [];
      const before: Array<EngineRun["status"]> = [];
      let last: EngineRun = yield* follow(handle, work);

      for (;;) {
        lanes.push(
          Object.fromEntries(
            ((yield* readRunHistoryHandler({ runId: last.id })).lanes ?? []).map((declared) => [
              declared.lane,
              declared.needs,
            ]),
          ),
        );

        if (last.status !== "ended-at-park") {
          break;
        }

        snapshots.push({ bases: bases(fake), status: Option.getOrElse(statusOf(fake), () => "") });
        const change = Arr.get(changes, snapshots.length - 1);

        if (Option.isNone(change)) {
          break;
        }

        change.value(fake);

        const offered = (yield* triggered(fake, Epic.queued).pipe(Effect.orDie)).filter(
          (found) => found.key === work.key,
        );

        before.push(last.status);

        last = yield* Effect.flatMap(
          takeUp(handle, offered),
          Option.match({
            onNone: () => Effect.die(`nothing took the epic up after change ${snapshots.length}`),
            onSome: Effect.succeed,
          }),
        );
      }

      return { run: last, snapshots, lanes, before };
    }),
  ).pipe(Effect.orDie);

describe("epic", () => {
  effect("finds open epics with an open task as work, keyed by the epic", () =>
    Effect.gen(function* () {
      const fake = epicFake();
      expect(yield* flowTriggered(fake, epic)).toEqual([
        expect.objectContaining({ key: `issue-${EPIC}`, data: { issue: EPIC } }),
      ]);

      fake.graph.subIssues.set(EPIC, []);
      expect(yield* flowTriggered(fake, epic)).toEqual([]);
    }),
  );

  effect(
    "opens a pull request per ready task, stacking one on the task it builds on, and parks",
    () =>
      Effect.gen(function* () {
        const fake = epicFake();

        const { before, lanes, run, snapshots } = yield* workWith(fake, [
          // #10 and #12 merge: #13 is no longer blocked.
          (changed) => {
            merge(changed, 10);
            merge(changed, 12);
          },
          // The rest merge: the epic is done.
          (changed) => {
            merge(changed, 11);
            merge(changed, 13);
          },
        ]);

        expect(run.status).toBe("done");
        // Each park ended its run, and a new run took the epic up.
        expect(before).toEqual(["ended-at-park", "ended-at-park"]);
        expect(summaryOf(run)).toBe(`#${EPIC}: every task is closed`);

        // First park: three pull requests, #11's on #10's branch; #13 waits on two.
        const first = Option.getOrElse(Arr.get(snapshots, 0), () => NOTHING);
        const second = Option.getOrElse(Arr.get(snapshots, 1), () => NOTHING);
        expect(first.bases).toEqual({
          "auto/issue-10": "main",
          "auto/issue-12": "main",
          "auto/issue-11": "auto/issue-10",
        });
        expect(first.status).toContain("#13 Task 13: held: waits on #10, #12");
        expect(first.status).toMatch(/#11 Task 11: in review: #\d+, stacked on #10/);
        expect(first.status).toMatch(/#12 Task 12: in review: #\d+\n/);

        // Taken up after the merges, a new run started #13 on the base branch, and parked.
        expect(second.bases).toEqual({
          "auto/issue-10": "main",
          "auto/issue-12": "main",
          "auto/issue-11": "auto/issue-10",
          "auto/issue-13": "main",
        });
        expect(second.status).toContain("#10 Task 10: merged");

        const body = Option.map(pullOf(fake, 11), (pull: PullRequest) => pull.body);
        expect(Option.getOrElse(body, () => "")).toContain(`Closes #11\nPart of #${EPIC}`);

        // Without ship, a person merges each layer.
        for (const pull of fake.branchPulls.values()) {
          expect(fake.labelsOf(pull.number)).not.toContain(DEFAULT_LABELS.ship);
        }

        // One status comment, edited each round.
        expect(
          fake.comments.filter((comment) => Option.isSome(Epic.statusMarker.read(comment.body))),
        ).toHaveLength(1);
        expect(Option.getOrElse(statusOf(fake), () => "")).toContain("#13 Task 13: merged");

        // Each task's steps carry its number, and each its own session.
        const steps = new Set(fake.steps.flatMap(Option.toArray));
        expect(
          ["implement#task-10", "implement#task-11", "implement#task-13"].filter(
            (step) => !steps.has(step),
          ),
        ).toEqual([]);
        expect(new Set(fake.requests.map((request) => request.sessionId)).size).toBe(4);

        // In each run, a task's lane waited on the lanes of the tasks it waited
        // on in that run: #11 stacked on #10. #13 started in a later run, once
        // #10 and #12 had merged, so its lane waits on none. The last run had
        // nothing left to start.
        expect(lanes).toEqual([
          { "task-10": [], "task-11": ["task-10"], "task-12": [] },
          { "task-13": [] },
          {},
        ]);

        // The runs let go of the epic's claim and its tasks'.
        expect(fake.refs.size).toBe(0);
      }),
    ENGINE_TIMEOUT,
  );

  effect(
    "starts a task again, as a new attempt, once a person hands it back with auto:eligible",
    () =>
      Effect.gen(function* () {
        const fake = epicFake();
        // #12's agent answers with questions the first time.
        fake.author.asks.push("/tmp/demo-worktrees/auto/issue-12");

        const { before, lanes, run, snapshots } = yield* workWith(fake, [
          // A person answers, and hands #12 back.
          (changed) => {
            changed.setLabels(12, [DEFAULT_LABELS.eligible]);
          },
          (changed) => {
            for (const number of [10, 11, 12, 13]) {
              merge(changed, number);
            }
          },
        ]);

        expect(run.status).toBe("done");
        // Each park ended its run, and a new run took the epic up.
        expect(before).toEqual(["ended-at-park", "ended-at-park"]);

        // Parked with #12 waiting for answers, and no pull request for it.
        const first = Option.getOrElse(Arr.get(snapshots, 0), () => NOTHING);
        const second = Option.getOrElse(Arr.get(snapshots, 1), () => NOTHING);
        expect(first.status).toContain(
          "#12 Task 12: a person's: waits for answers to its questions",
        );
        expect(first.bases["auto/issue-12"]).toBeUndefined();

        // Handed back, it was implemented again, in steps and a session of its own.
        expect(second.bases["auto/issue-12"]).toBe("main");
        expect(second.status).toMatch(/#12 Task 12: in review: #\d+\n/);

        const steps = new Set(fake.steps.flatMap(Option.toArray));
        expect(
          ["implement#task-12", "implement#task-12-2"].filter((step) => !steps.has(step)),
        ).toEqual([]);
        // The second attempt's lane, in the run that took #12 up again, follows
        // the first, which the epic's record carried over.
        expect(lanes[1]).toEqual({ "task-12-2": ["task-12"] });
        // #10, #11, #12 and #12's second attempt; #13 merged without the run.
        expect(new Set(fake.requests.map((request) => request.sessionId)).size).toBe(4);
        expect(fake.refs.size).toBe(0);
      }),
    ENGINE_TIMEOUT,
  );

  effect("with ship, labels each pull request it opens auto:ship, the automated path", () =>
    Effect.gen(function* () {
      const fake = epicFake();
      const { snapshots } = yield* workWith(fake, [], shipping);
      expect(snapshots).toHaveLength(1);
      expect(fake.branchPulls.size).toBe(3);

      for (const pull of fake.branchPulls.values()) {
        expect(fake.labelsOf(pull.number)).toContain(DEFAULT_LABELS.ship);
      }
    }),
  );

  effect("declares atOnce and ship among its settings, so config.yaml may set them", () =>
    Effect.gen(function* () {
      const schema = Option.fromUndefinedOr(epic.settings);
      expect(Option.isSome(schema)).toBe(true);

      for (const found of Option.toArray(schema)) {
        expect(yield* Schema.decodeEffect(found)({ atOnce: 5, ship: true })).toEqual(
          expect.objectContaining({ atOnce: 5, ship: true }),
        );
      }
    }),
  );

  effect("offers a parked epic, with a signal, only once a layer changes since it parked", () =>
    Effect.gen(function* () {
      const fake = epicFake();
      const { snapshots } = yield* workWith(fake, []);
      expect(snapshots).toHaveLength(1);

      // The run ended at its park with nothing changed since: nothing to start.
      expect(yield* triggered(fake, Epic.queued)).toEqual([]);

      // A push to #10's pull request is a change.
      for (const pull of Option.toArray(pullOf(fake, 10))) {
        fake.branchPulls.set(pull.headRef, { ...pull, headSha: "pushed000" });
      }

      const pushed = yield* triggered(fake, Epic.queued);
      expect(pushed.map((found) => found.signals)).toEqual([[Epic.LAYER_CHANGED]]);
    }),
  );
});
