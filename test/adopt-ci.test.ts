// An adopted draft waited on in a CI job (audit W1, ADR 0021 decision 4): the
// job ends at the park and its journal goes with it, so the wait lives in the
// issue's awaiting-ready record. Once the draft is marked ready, or the wait's
// time is up, Implement.readied offers the issue as work a run may start, and
// a new run takes it on from the record.

import { DEFAULT_LABELS, Implement, type Json, Phases } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import implement from "../packages/recipes/flows/implement.ts";
import { mayStart } from "../src/modules/runs/domain/run/work-item.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import { effect } from "./effect-test.ts";
import {
  type Fake,
  ISSUE,
  item,
  makeFake,
  PULL,
  repo,
  runToEnd,
  runUntil,
  triggered,
} from "./sdk-fakes.ts";

const implementing = flowHandle(repo, "implement", implement);
const ISSUE_ITEM = Phases.issueItem(ISSUE);
const POOL = { reviewers: ["zach", "data-quail"] };
const BRANCH = "zach/fix-it";
const PULL_URL = `https://github.com/dataquail/demo/pull/${PULL}`;
const FOURTEEN_DAYS = Duration.toMillis(Duration.days(14));

// An open pull request that closes the issue, as GitHub's GraphQL API gives it.
const closingPull = (draft: boolean): Json => ({
  number: PULL,
  url: PULL_URL,
  state: "OPEN",
  isDraft: draft,
  headRefName: BRANCH,
  baseRefName: "main",
  isCrossRepository: false,
});

// A person's pull request already closes the issue, in a CI job.
const withPull = (fake: Fake, draft: boolean) => {
  fake.setLabels(PULL, []);
  fake.git.opened = true;
  fake.authored.headRef = BRANCH;
  fake.authored.author = "zach";
  fake.authored.draft = draft;
  fake.closing.push(closingPull(draft));

  return fake;
};

// What a CI job that parked on the draft and ended leaves behind: the
// issue's record of the wait, written `at`, naming the draft. Its claim
// comment, which told people it adopted the draft, is gone: a person deleted
// it, and the record alone says so.
const parkedEarlier = (draft: boolean, at: DateTime.Utc) => {
  const fake = withPull(makeFake("approve", { ...POOL, ciJob: true }), draft);
  fake.setLabels(ISSUE, [DEFAULT_LABELS.inProgress]);
  fake.recordPhase(ISSUE_ITEM, Phases.PHASES.issue.awaitingReady, {
    at,
    data: { pullRequest: PULL, withinMillis: FOURTEEN_DAYS, since: DateTime.formatIso(at) },
  });

  return fake;
};

const offered = (fake: Fake) => triggered(fake, Implement.readied).pipe(Effect.orDie);

// The one item offered, which the test goes on with.
const onlyOffered = (fake: Fake) =>
  Effect.flatMap(offered(fake), (items) => Effect.fromOption(Arr.head(items))).pipe(Effect.orDie);

describe("an adopted draft in a CI job", () => {
  effect("parks on the issue's record, and once marked ready is work a new run may start", () =>
    Effect.gen(function* () {
      const fake = withPull(makeFake("approve", { ...POOL, ciJob: true }), true);
      fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);

      const run = yield* runUntil(
        implementing,
        fake,
        item(`issue-${ISSUE}`, { issue: ISSUE }),
        (polled) =>
          Effect.map(listRunWaitsHandler({ runId: polled.id, signal: "ready" }), ({ waits }) =>
            waits.some((wait) => wait.deferred === `ready:draft-${PULL}`),
          ),
      );

      expect(run.status).toBe("running");

      // The wait is the record, with the draft and how long it waits.
      const record = Option.fromUndefinedOr(fake.records().get(ISSUE_ITEM));
      expect(fake.phases()[ISSUE_ITEM]).toBe("awaiting-ready");
      expect(
        Option.map(
          Option.flatMap(record, (found) => found.data),
          (data) => [data.pullRequest, data.withinMillis],
        ),
      ).toEqual(Option.some([PULL, FOURTEEN_DAYS]));

      // Still a draft, with time left: nothing to start.
      expect(yield* offered(fake)).toEqual([]);

      // Marked ready: the issue is work a run may start, not only a wake.
      fake.authored.draft = false;
      const ready = yield* offered(fake);
      expect(ready.map((found) => [found.key, found.signals, mayStart(found)])).toEqual([
        [`issue-${ISSUE}`, ["ready"], true],
      ]);
    }),
  );

  effect("a new run, once the draft is ready, takes it up again and hands it off", () =>
    Effect.gen(function* () {
      const fake = parkedEarlier(false, yield* DateTime.now);
      const resumed = yield* onlyOffered(fake);

      const finished = yield* runToEnd(implementing, fake, resumed);

      expect(finished.status).toBe("done");
      expect(fake.requests).toEqual([]);
      expect(fake.people.requested).toHaveLength(1);
      expect(fake.phases()[ISSUE_ITEM]).toBe("handed-off");
      // The issue says the run took the pull request up again, not that it adopted a new one.
      expect(fake.comments.some((comment) => comment.body.startsWith(`Took #${PULL}`))).toBe(true);
      expect(fake.comments.some((comment) => comment.body.startsWith(`Adopted #${PULL}`))).toBe(
        false,
      );
    }),
  );

  effect("once the wait's time is up, a new run hands the still-draft issue to a person", () =>
    Effect.gen(function* () {
      const fake = parkedEarlier(true, DateTime.makeUnsafe("2026-01-01T00:00:00Z"));
      const due = yield* onlyOffered(fake);

      // Its time is up, though it is still a draft: work a run may start, with no signal.
      expect([due.key, Option.fromUndefinedOr(due.signals), mayStart(due)]).toEqual([
        `issue-${ISSUE}`,
        Option.none(),
        true,
      ]);

      const finished = yield* runToEnd(implementing, fake, due);

      expect(finished.status).toBe("needs-human");
      expect(fake.phases()[ISSUE_ITEM]).toBe("ready-timed-out");
      expect(fake.labelsOf(ISSUE)).toContain(DEFAULT_LABELS.needsHuman);
      // Nothing waits any more, so nothing is offered again.
      expect(yield* offered(fake)).toEqual([]);
    }),
  );

  effect("with time left, a draft still unready is not offered", () =>
    Effect.gen(function* () {
      const fake = parkedEarlier(true, yield* DateTime.now);

      expect(yield* offered(fake)).toEqual([]);
    }),
  );

  effect("taking the awaiting-ready label off changes nothing", () =>
    Effect.gen(function* () {
      const fake = parkedEarlier(false, yield* DateTime.now);
      fake.setLabels(ISSUE, []);

      expect((yield* offered(fake)).map((found) => found.key)).toEqual([`issue-${ISSUE}`]);
    }),
  );
});
