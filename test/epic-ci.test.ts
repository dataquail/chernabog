// An epic parked between rounds (audit W10 and S4, ADR 0021 decisions 3 and
// 4): a daemon's run or a CI job's ends at the park, so the wait lives in the
// epic's waiting record, with the fingerprint of the epic as the run last
// read it and what the run kept between rounds. Epic.queued offers the epic
// again only once a layer changed since, or a day passed, and the new run
// carries on from what the record kept.

import { Claims, DEFAULT_LABELS, Epic, type LinkedIssue, Plan } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import epic from "../packages/recipes/flows/epic.ts";
import { mayStart } from "../src/modules/runs/domain/run/work-item.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import { effect } from "./effect-test.ts";
import {
  type EngineRun,
  type Fake,
  item,
  makeFake,
  onFake,
  repo,
  runToEnd,
  runUntil,
  summaryOf,
  triggered,
} from "./sdk-fakes.ts";

const EPIC = 40;
const EPIC_ITEM = Claims.epic(EPIC);
const working = flowHandle(repo, "epic", epic);

// The tests that run the epic through the engine to its park take
// milliseconds alone, but under the whole suite's load the engine's runner can
// miss health checks for seconds, as plan-ci's and epic-stack's do.
const ENGINE_TIMEOUT = 60_000;

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

// The epic, in a CI job: #10, then #11 on it; #12 on its own; and #13, which
// needs both #10 and #12.
const epicFake = () => {
  const fake = makeFake("approve", { ciJob: true });
  fake.graph.made.set(EPIC, madeIssue(EPIC, "An epic"));
  fake.setLabels(EPIC, [Plan.LABELS.epic]);
  task(fake, 10);
  task(fake, 11, [10]);
  task(fake, 12);
  task(fake, 13, [10, 12]);

  return fake;
};

const offered = (fake: Fake) => triggered(fake, Epic.queued).pipe(Effect.orDie);

const onlyOffered = (fake: Fake) =>
  Effect.flatMap(offered(fake), (items) => Effect.fromOption(Arr.head(items))).pipe(Effect.orDie);

// What the epic's waiting record keeps, decoded.
const kept = (fake: Fake) =>
  Option.flatMap(Option.fromUndefinedOr(fake.records().get(EPIC_ITEM)), (record) =>
    Option.flatMap(record.data, (data) => Epic.resuming(item("any", { resumeEpic: data }))),
  );

// Pairs by their first number, as a record keeps them in the order the run met them.
const sorted = (pairs: ReadonlyArray<readonly [number, number]>) =>
  pairs.toSorted(([left], [right]) => left - right);

// Whether the run is parked on the epic's round `round`.
const parkedAt = (round: number) => (run: EngineRun) =>
  Effect.map(listRunWaitsHandler({ runId: run.id, signal: Epic.LAYER_CHANGED }), ({ waits }) =>
    waits.some((wait) => wait.deferred === `${Epic.LAYER_CHANGED}:epic-${round}`),
  );

// Runs the epic from `work` until it parks, then lets go of every claim, as a
// run ending at its park does.
const runToPark = (fake: Fake, work: ReturnType<typeof item>, round = 1) =>
  Effect.gen(function* () {
    const run = yield* runUntil(working, fake, work, parkedAt(round));
    fake.refs.clear();

    return run;
  });

const fresh = item(`issue-${EPIC}`, { issue: EPIC });

const pushTo = (fake: Fake, number: number) => {
  for (const pull of Option.toArray(
    Option.fromUndefinedOr(fake.branchPulls.get(Claims.branchFor(number))),
  )) {
    fake.branchPulls.set(pull.headRef, { ...pull, headSha: "pushed000" });
  }
};

describe("an epic parked in a CI job", () => {
  effect(
    "records its wait with what the run kept, and is offered again only once a layer changes",
    () =>
      Effect.gen(function* () {
        const fake = epicFake();
        const run = yield* runToPark(fake, fresh);

        expect(run.status).toBe("running");
        expect(fake.phases()[EPIC_ITEM]).toBe("waiting");

        const waiting = kept(fake);
        expect(Option.map(waiting, (found) => sorted(found.tasks.attempts))).toEqual(
          Option.some([
            [10, 1],
            [11, 1],
            [12, 1],
          ]),
        );

        // Nothing changed since it parked: nothing to start, and nothing to wake.
        expect(yield* offered(fake)).toEqual([]);

        // A push to #10's pull request: work a new run may start, from the record.
        pushTo(fake, 10);
        const changed = yield* onlyOffered(fake);

        expect([changed.key, changed.signals, mayStart(changed)]).toEqual([
          `issue-${EPIC}`,
          [Epic.LAYER_CHANGED],
          true,
        ]);
        expect(Epic.resuming(changed)).toEqual(waiting);
      }),
    ENGINE_TIMEOUT,
  );

  effect(
    "a new run carries on with the attempts the parked one kept",
    () =>
      Effect.gen(function* () {
        const fake = epicFake();
        // #12's agent answers with questions the first time.
        fake.author.asks.push("/tmp/demo-worktrees/auto/issue-12");
        yield* runToPark(fake, fresh);

        // Every task attempted read as something other than ready since, #12
        // as a person's: each may start again once ready.
        expect(
          Option.map(kept(fake), (found) => found.tasks.handedBack.toSorted((a, b) => a - b)),
        ).toEqual(Option.some([10, 11, 12]));

        // A person answers, and hands #12 back.
        fake.setLabels(12, [DEFAULT_LABELS.eligible]);
        const resumed = yield* onlyOffered(fake);
        yield* runToPark(fake, resumed);

        // The new run took #12 up as its second attempt, and started nothing else again.
        const steps = fake.steps.flatMap(Option.toArray);
        expect(steps).toContain("implement#task-12-2");

        for (const once of ["implement#task-10", "implement#task-11", "implement#task-12"]) {
          expect(steps.filter((step) => step === once)).toHaveLength(1);
        }

        expect(Option.map(kept(fake), (found) => sorted(found.tasks.attempts))).toEqual(
          Option.some([
            [10, 1],
            [11, 1],
            [12, 2],
          ]),
        );
        expect(yield* offered(fake)).toEqual([]);
      }),
    ENGINE_TIMEOUT,
  );

  effect("deleting the epic's status comment changes nothing", () =>
    Effect.gen(function* () {
      const fake = epicFake();
      const fingerprint = yield* onFake(fake, Epic.fingerprint(EPIC)).pipe(Effect.orDie);

      fake.recordPhase(EPIC_ITEM, "waiting", {
        at: yield* DateTime.now,
        data: { fingerprint, tasks: { attempts: [], handedBack: [], withPerson: [] } },
      });

      fake.comments.length = 0;
      expect(yield* offered(fake)).toEqual([]);
    }),
  );

  effect("once a day passes with no layer changed, it is offered without a signal", () =>
    Effect.gen(function* () {
      const fake = epicFake();
      const fingerprint = yield* onFake(fake, Epic.fingerprint(EPIC)).pipe(Effect.orDie);

      fake.recordPhase(EPIC_ITEM, "waiting", {
        at: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
        data: { fingerprint, tasks: { attempts: [[10, 1]], handedBack: [], withPerson: [] } },
      });

      const due = yield* onlyOffered(fake);
      expect(Option.fromUndefinedOr(due.signals)).toEqual(Option.none());
      expect(mayStart(due)).toBe(true);
      expect(Option.map(Epic.resuming(due), (found) => found.tasks.attempts)).toEqual(
        Option.some([[10, 1]]),
      );
    }),
  );

  effect("a new run ends an epic whose last task closed, and records it finished", () =>
    Effect.gen(function* () {
      const fake = epicFake();

      fake.recordPhase(EPIC_ITEM, "waiting", {
        at: yield* DateTime.now,
        data: { fingerprint: "stale", tasks: { attempts: [], handedBack: [], withPerson: [] } },
      });

      for (const number of [10, 11, 12, 13]) {
        fake.graph.made.set(number, { ...madeIssue(number, `Task ${number}`), state: "closed" });
      }

      const finished = yield* runToEnd(working, fake, yield* onlyOffered(fake));

      expect(finished.status).toBe("done");
      expect(summaryOf(finished)).toBe(`#${EPIC}: every task is closed`);
      expect(fake.phases()[EPIC_ITEM]).toBe("finished");
      expect(yield* offered(fake)).toEqual([]);
    }),
  );
});
