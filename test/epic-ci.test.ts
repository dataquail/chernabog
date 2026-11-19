// An epic parked between rounds (audit W10 and S4, ADR 0021 decisions 3 and
// 4): a daemon's run or a CI job's ends at the park, so the wait lives in the
// epic's waiting record, with the fingerprint of the epic as the run last
// read it and what the run kept between rounds. Epic.queued offers the epic
// again only once a layer changed since, or a day passed, and the new run
// carries on from what the record kept.
//
// A layer's refresh whose CI is pending (audit W7) can't park on its own
// either: the refresh ends there, the layers above it wait, and so does its
// review, and the epic parks with the refresh in its record (`layers.ci`).
// Epic.queued holds the epic, with why, until that CI settles or ciTimeout
// passes, and the run that takes it up takes the refresh up first.

import {
  Claims,
  DEFAULT_LABELS,
  Epic,
  type LinkedIssue,
  Plan,
  type PullRequest,
  Stack,
  type WorkItem,
} from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import epic from "../packages/recipes/flows/epic.ts";
import { mayStart } from "../src/modules/runs/domain/run/work-item.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import { documentOf, EPIC_DOCUMENT, loadFlow } from "./compose-harness.ts";
import { effect } from "./effect-test.ts";
import {
  type EngineRun,
  type Fake,
  flowTriggered,
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

const PENDING: Fake["merge"]["ci"] = { state: "pending", waitingOn: ["test"] };

// The layers of a stack in review: #10's pull request on main, #11's on
// #10's branch, and #12's on #11's.
const STACK = [10, 11, 12] as const;

const BELOW = new Map([
  [11, 10],
  [12, 11],
]);

const pullOf = (layer: number) => 300 + layer;
const MIDDLE = pullOf(11);
const REVIEWED = "reviewed0000";

const layerPull = (layer: number): PullRequest => ({
  number: pullOf(layer),
  title: `Task ${layer}`,
  body: `Closes #${layer}\nPart of #${EPIC}`,
  url: `https://github.com/dataquail/demo/pull/${pullOf(layer)}`,
  state: "open",
  headRef: Claims.branchFor(layer),
  headSha: `head${layer}`,
  baseRef: Option.match(Option.fromUndefinedOr(BELOW.get(layer)), {
    onNone: () => "main",
    onSome: Claims.branchFor,
  }),
  labels: [],
  author: "chernabog-bot",
  assignees: [],
  requestedReviewers: [],
});

// The epic over the stack, every layer in review, with #10's branch moved
// on since #11 was brought up to it: refreshing #11 merges something in, and
// pushes. CI on the pull requests reads `ci`.
const stackFake = (ci: Fake["merge"]["ci"]) => {
  const fake = makeFake("approve", { reviewers: ["zach", "data-quail"] });
  fake.graph.made.set(EPIC, madeIssue(EPIC, "An epic"));
  fake.setLabels(EPIC, [Plan.LABELS.epic]);

  for (const layer of STACK) {
    task(fake, layer, Option.toArray(Option.fromUndefinedOr(BELOW.get(layer))));
    fake.branchPulls.set(Claims.branchFor(layer), layerPull(layer));
  }

  fake.git.makes.add(`merge --no-edit origin/${Claims.branchFor(10)}`);
  fake.merge.ci = ci;

  // zach reviewed a commit the refreshed head is more than a merge of the
  // base onto, so a refresh that settles asks them again.
  fake.submitted.push({ author: "zach", state: "CHANGES_REQUESTED", commitSha: REVIEWED });
  fake.git.refuses.add(`rev-parse --verify --quiet ${REVIEWED}^{commit}`);

  return fake;
};

const refreshesLeft = (fake: Fake) =>
  Option.getOrElse(
    Option.flatMap(kept(fake), (found) => Option.fromUndefinedOr(found.layers?.ci)),
    (): ReadonlyArray<Epic.PendingRefresh> => [],
  );

// Whether #12's layer was refreshed: its refresh fetches its base, #11's branch.
const topRefreshed = (fake: Fake) =>
  fake.git.ran.includes(`fetch --quiet origin ${Claims.branchFor(11)}`);

const forms = [
  ["the recipe", Effect.succeed(epic)],
  ["the document", loadFlow(documentOf(EPIC_DOCUMENT))],
] as const;

for (const [form, loading] of forms) {
  const handle = Effect.map(loading, (flow) => flowHandle(repo, "epic", flow));

  const offeredBy = (fake: Fake) =>
    Effect.gen(function* () {
      return yield* flowTriggered(fake, yield* loading);
    }).pipe(Effect.orDie);

  const onlyOfferedBy = (fake: Fake) =>
    Effect.flatMap(offeredBy(fake), (items) => Effect.fromOption(Arr.head(items))).pipe(
      Effect.orDie,
    );

  const parkAt = (fake: Fake, work: WorkItem, round: number) =>
    Effect.gen(function* () {
      const run = yield* runUntil(yield* handle, fake, work, parkedAt(round));
      fake.refs.clear();

      return run;
    });

  // The epic whose run left #11's refresh on pending CI and parked, with CI
  // now `ci`.
  const refreshLeft = (ci: Fake["merge"]["ci"]) =>
    Effect.gen(function* () {
      const fake = stackFake(PENDING);
      yield* parkAt(fake, fresh, 2);
      fake.merge.ci = ci;

      return fake;
    });

  // Takes the parked epic up, as the run its trigger starts, to its next park.
  const takenUp = (fake: Fake) =>
    Effect.gen(function* () {
      const taken = yield* onlyOfferedBy(fake);
      expect(mayStart(taken)).toBe(true);

      return yield* parkAt(fake, taken, 2);
    });

  describe(`the epic's ${form}, on a layer's refresh whose CI is pending`, () => {
    effect(
      "ends the refresh rather than poll, holds the layers above, and parks with it in the epic's record",
      () =>
        Effect.gen(function* () {
          const before = yield* DateTime.now;
          const fake = stackFake(PENDING);
          const run = yield* parkAt(fake, fresh, 2);

          expect(run.status).toBe("running");
          expect(fake.phases()[EPIC_ITEM]).toBe("waiting");

          const [left] = refreshesLeft(fake);
          expect(left).toMatchObject({
            layer: 11,
            pullRequest: MIDDLE,
            base: Claims.branchFor(10),
            round: 1,
          });
          expect(
            Option.exists(DateTime.make(left.since), (began) =>
              DateTime.isGreaterThanOrEqualTo(began, before),
            ),
          ).toBe(true);

          // It pushed, and its review waits for CI.
          expect(fake.git.pushes).toBe(1);
          expect(fake.people.requested).toEqual([]);
          // #12, on #11, wasn't refreshed meanwhile.
          expect(topRefreshed(fake)).toBe(false);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "is held, with why, while the refresh's CI is still pending",
      () =>
        Effect.gen(function* () {
          const fake = yield* refreshLeft(PENDING);
          const held = yield* onlyOfferedBy(fake);

          expect(mayStart(held)).toBe(false);
          expect(held.held).toBe(`#11: waits on CI for #${MIDDLE}`);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "once CI went green, is offered, and the run that takes it up settles its review, then carries the layer above",
      () =>
        Effect.gen(function* () {
          const fake = yield* refreshLeft({ state: "green" });
          const pushes = fake.git.pushes;

          expect(topRefreshed(fake)).toBe(false);
          yield* takenUp(fake);

          // zach is asked again, nothing was pushed to #11 again, and #12
          // was brought up after it.
          expect(fake.people.requested).toEqual(["zach"]);
          expect(fake.git.pushes).toBe(pushes);
          expect(topRefreshed(fake)).toBe(true);
          expect(refreshesLeft(fake)).toEqual([]);
          expect(fake.labelsOf(MIDDLE)).not.toContain(DEFAULT_LABELS.needsHuman);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "once CI went red, is offered, and the run that takes it up fixes it, then settles its review",
      () =>
        Effect.gen(function* () {
          const fake = yield* refreshLeft({ state: "red", failedChecks: ["test"] });
          const pushes = fake.git.pushes;
          fake.merge.afterPush = Option.some({ state: "green" });
          yield* takenUp(fake);

          expect(fake.git.pushes).toBe(pushes + 1);
          expect(fake.requests.at(-1)?.prompt).toContain("CI failed on pull request");
          expect(fake.people.requested).toEqual(["zach"]);
          expect(refreshesLeft(fake)).toEqual([]);
        }),
      ENGINE_TIMEOUT,
    );

    effect(
      "still pending past ciTimeout, counted from when the wait began, gives the layer to a person and holds the one above",
      () =>
        Effect.gen(function* () {
          const fake = yield* refreshLeft(PENDING);
          const waiting = Option.getOrThrow(kept(fake));

          const since = DateTime.formatIso(
            DateTime.subtractDuration(yield* DateTime.now, Duration.hours(3)),
          );

          const layers = Option.getOrThrow(Option.fromUndefinedOr(waiting.layers));
          const ci = (layers.ci ?? []).map((one) => ({ ...one, since }));

          const data = yield* Schema.encodeEffect(Epic.Waiting)({
            ...waiting,
            layers: { ...layers, ci },
          }).pipe(Effect.orDie);

          fake.recordPhase(EPIC_ITEM, "waiting", { data });
          yield* takenUp(fake);

          expect(fake.labelsOf(MIDDLE)).toContain(DEFAULT_LABELS.needsHuman);
          expect(
            fake.comments.some((comment) =>
              comment.body.startsWith("Chernabog stopped bringing this layer up to date"),
            ),
          ).toBe(true);
          expect(fake.people.requested).toEqual([]);
          expect(topRefreshed(fake)).toBe(false);
          expect(refreshesLeft(fake)).toEqual([]);
        }),
      ENGINE_TIMEOUT,
    );
  });
}

describe("the refreshes an epic's record keeps", () => {
  // The most a refresh keeps: a long base, a full sha, and what it says cut to SAID_SIZE.
  const largest = (layer: number): Epic.PendingRefresh => ({
    layer: 1000 + layer,
    pullRequest: 10_000 + layer,
    baseSha: "f".repeat(40),
    lower: 9999,
    base: `auto/issue-${1000 + layer}`,
    round: 9,
    since: "2026-11-19T12:34:56.789Z",
    said: "x".repeat(Stack.SAID_SIZE),
  });

  // A layer's refresh after the one below moved, which says only what it merged.
  const plain = (layer: number): Epic.PendingRefresh => ({
    layer: 1000 + layer,
    pullRequest: 10_000 + layer,
    baseSha: "f".repeat(40),
    base: `auto/issue-${1000 + layer}`,
    round: 9,
    since: "2026-11-19T12:34:56.789Z",
    said: `Merged \`auto/issue-${1000 + layer}\` at \`abcdef1\` into this branch.`,
  });

  effect("keep six layers at their largest, nine plain ones, and no more than their share", () =>
    Effect.sync(() => {
      const of = (count: number, one: (layer: number) => Epic.PendingRefresh) =>
        Array.from({ length: count }, (_, index) => one(index));

      expect(Epic.fitsRefreshCi(of(6, largest))).toBe(true);
      expect(Epic.fitsRefreshCi(of(7, largest))).toBe(false);
      expect(Epic.fitsRefreshCi(of(9, plain))).toBe(true);
      expect(Epic.fitsRefreshCi(of(10, plain))).toBe(false);
      // The record past them still has room for the rest of what it keeps.
      expect(Epic.REFRESH_CI_SIZE).toBeLessThanOrEqual(4096 / 2);
    }),
  );
});

const decodeWaiting = Schema.decodeUnknownOption(Epic.Waiting);

describe("the epic's waiting record, when what the run kept is too big for it", () => {
  const pendingCi = (issue: number): Epic.PendingCi => ({
    issue,
    pullRequest: issue + 100,
    lane: `lane-${issue}`,
    branch: `auto/issue-${issue}`,
    round: 1,
    since: "2026-11-19T12:00:00.000Z",
  });

  test("keeps the tasks left on pending CI, dropping the attempts first", () => {
    const attempts = Arr.makeBy(600, (index): readonly [number, number] => [1000 + index, 3]);
    const ci = [pendingCi(10), pendingCi(11)];

    const data = Epic.waitingData({
      fingerprint: "f",
      tasks: { attempts, handedBack: [], withPerson: [], ci },
    });

    expect(Option.map(decodeWaiting(data), (decoded) => decoded.tasks)).toEqual(
      Option.some({ attempts: [], handedBack: [], withPerson: [], ci }),
    );
  });

  test("keeps the refreshes left on pending CI beside the tasks", () => {
    const attempts = Arr.makeBy(600, (index): readonly [number, number] => [1000 + index, 3]);
    const ci = [pendingCi(10)];

    const refreshes: ReadonlyArray<Epic.PendingRefresh> = [
      {
        layer: 11,
        pullRequest: 111,
        baseSha: "abc1234",
        round: 1,
        base: "auto/issue-10",
        since: "2026-11-19T12:00:00.000Z",
        said: "brought up to date with #110",
      },
    ];

    const data = Epic.waitingData({
      fingerprint: "f",
      tasks: { attempts, handedBack: [], withPerson: [], ci },
      layers: {
        attempts: [],
        recorded: [],
        withPerson: [],
        below: [],
        caughtUp: [],
        ci: refreshes,
      },
    });

    const recorded = decodeWaiting(data);

    expect(Option.map(recorded, (decoded) => decoded.tasks.ci)).toEqual(Option.some(ci));
    expect(Option.map(recorded, (decoded) => decoded.layers?.ci)).toEqual(Option.some(refreshes));
  });

  test("keeps everything when it fits", () => {
    const waiting: Epic.Waiting = {
      fingerprint: "f",
      tasks: { attempts: [[10, 1]], handedBack: [], withPerson: [], ci: [pendingCi(10)] },
    };

    expect(decodeWaiting(Epic.waitingData(waiting))).toEqual(Option.some(waiting));
  });
});
