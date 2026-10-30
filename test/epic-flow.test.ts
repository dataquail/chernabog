// The epic recipe through the engine, on an in-memory GitHub: an epic of
// tasks, some building on others, implemented as pull requests stacked on the
// branch of the task each builds on; a task still blocked twice over waits;
// and the run parks between rounds until a layer's pull request changes.

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

import epic from "../packages/recipes/flows/epic.ts";
import { IMPLICIT } from "../src/kernel/persona.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsUseCase } from "../src/modules/runs/use-cases/list-run-waits.use-case.ts";
import { effect } from "./effect-test.ts";
import {
  deliverSignals,
  type Fake,
  flowTriggered,
  item,
  makeFake,
  repo,
  runUntil,
  summaryOf,
  triggered,
} from "./sdk-fakes.ts";

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

// Runs the epic flow; each time it parks, records what the fake looks like,
// makes the next change and delivers what the trigger then reports, as the
// daemon's ticks would, until the run ends or no change is left.
const workWith = (
  fake: Fake,
  changes: ReadonlyArray<(fake: Fake) => void>,
  handle: typeof working = working,
) => {
  const snapshots: Array<Snapshot> = [];
  const answered = new Set<string>();

  const run = runUntil(handle, fake, work, (current) =>
    Effect.gen(function* () {
      if (current.status !== "running") {
        return true;
      }

      const { waits } = yield* listRunWaitsUseCase(current.id, Epic.LAYER_CHANGED);
      const parked = Arr.findFirst(waits, (wait) => !answered.has(wait.deferred));

      if (Option.isNone(parked)) {
        return false;
      }

      const change = Arr.get(changes, answered.size);

      if (snapshots.length === answered.size) {
        snapshots.push({ bases: bases(fake), status: Option.getOrElse(statusOf(fake), () => "") });

        for (const next of Option.toArray(change)) {
          next(fake);
        }
      }

      if (Option.isNone(change)) {
        return true;
      }

      const found = yield* triggered(fake, Epic.queued).pipe(Effect.orDie);

      if ((yield* deliverSignals(handle, IMPLICIT, found)) > 0) {
        answered.add(parked.value.deferred);
      }

      return false;
    }),
  );

  return Effect.map(run, (ended) => ({ run: ended, snapshots }));
};

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

        const { run, snapshots } = yield* workWith(fake, [
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

        // Woken by the merges, it started #13 on the base branch, and parked again.
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

        // The run let go of the epic's claim and its tasks'.
        expect(fake.refs.size).toBe(0);
      }),
  );

  effect(
    "starts a task again, as a new attempt, once a person hands it back with auto:eligible",
    () =>
      Effect.gen(function* () {
        const fake = epicFake();
        // #12's agent answers with questions the first time.
        fake.author.asks.push("/tmp/demo-worktrees/auto/issue-12");

        const { run, snapshots } = yield* workWith(fake, [
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
        // #10, #11, #12 and #12's second attempt; #13 merged without the run.
        expect(new Set(fake.requests.map((request) => request.sessionId)).size).toBe(4);
        expect(fake.refs.size).toBe(0);
      }),
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

  effect("signals a parked run only once a layer changes since its status", () =>
    Effect.gen(function* () {
      const fake = epicFake();
      const { snapshots } = yield* workWith(fake, []);
      expect(snapshots).toHaveLength(1);

      // The run parked with nothing changed since: no signal.
      const quiet = yield* triggered(fake, Epic.queued);
      expect(quiet.map((found) => Option.fromUndefinedOr(found.signals))).toEqual([Option.none()]);

      // A push to #10's pull request is a change.
      for (const pull of Option.toArray(pullOf(fake, 10))) {
        fake.branchPulls.set(pull.headRef, { ...pull, headSha: "pushed000" });
      }

      const pushed = yield* triggered(fake, Epic.queued);
      expect(pushed.map((found) => found.signals)).toEqual([[Epic.LAYER_CHANGED]]);
    }),
  );
});
