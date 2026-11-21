// A plan waiting on a person's answer in a CI job (audit W2, ADR 0021
// decision 4): the job ends at the park and its journal goes with it, so the
// wait lives in the spec's proposed record and the tasks in the plan's
// marker. Once a person answers, or nobody does in time, Plan.answered offers
// the spec as work a run may start, and a new run takes it up from there.

import { DEFAULT_LABELS, type Json, Plan, planMarker } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import plan from "../packages/recipes/flows/plan.ts";
import { mayStart } from "../src/modules/runs/domain/run/work-item.value-object.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunWaitsHandler } from "../src/modules/runs/queries/list-run-waits.handler.ts";
import { effect } from "./effect-test.ts";
import {
  type Fake,
  ISSUE,
  item,
  makeFake,
  repo,
  runToEnd,
  runUntil,
  summaryOf,
  triggered,
} from "./sdk-fakes.ts";

const planning = flowHandle(repo, "plan", plan);
const SPEC_ITEM = `issue-${ISSUE}`;
const WITHIN = "14 days";

const task = (key: string, kind: string, blockedBy: ReadonlyArray<string> = []) => ({
  key,
  title: `Do ${key}`,
  body: `What ${key} is.`,
  kind,
  blockedBy: [...blockedBy],
});

const NODES = [task("api-schema", "auto"), task("api", "hybrid", ["api-schema"])];
const SUMMARY = "The schema first, then the API on it.";
const PLAN: Json = { status: "plan", summary: SUMMARY, nodes: NODES };

// What a CI job that posted round `round`'s plan and ended leaves behind: the
// plan's comment, its marker keeping the tasks, and the spec's record, written `at`.
const postedEarlier = (round: number, at: DateTime.Utc, comment?: string) => {
  const fake = makeFake("approve", { ciJob: true });
  fake.setLabels(ISSUE, [DEFAULT_LABELS.inProgress, Plan.LABELS.proposed]);
  fake.comment(comment ?? Plan.planComment(round, SUMMARY, Schema.decodeSync(Plan.Plan)(NODES)));
  fake.recordPhase(SPEC_ITEM, "proposed", { at, data: { round } });

  return fake;
};

// The tests that run the plan through the engine to its park take
// milliseconds alone, but under the whole suite's load the engine's runner can
// miss health checks for seconds before it marks itself healthy again
// (effect/cluster's "No healthy runners available"), as epic-stack's do.
const ENGINE_TIMEOUT = 60_000;

const offered = (fake: Fake) => triggered(fake, Plan.answered(WITHIN)).pipe(Effect.orDie);

const onlyOffered = (fake: Fake) =>
  Effect.flatMap(offered(fake), (items) => Effect.fromOption(Arr.head(items))).pipe(Effect.orDie);

describe("a plan in a CI job", () => {
  effect(
    "parks on the spec's record, and once answered is work a new run may start",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve", { ciJob: true });
        fake.setLabels(ISSUE, [Plan.LABELS.plan]);
        fake.plans.push(PLAN);

        const run = yield* runUntil(
          planning,
          fake,
          item(SPEC_ITEM, { issue: ISSUE, label: Plan.LABELS.plan }),
          (polled) =>
            Effect.map(listRunWaitsHandler({ runId: polled.id, signal: "approved" }), ({ waits }) =>
              waits.some((wait) => wait.deferred === "approved:plan-1"),
            ),
        );

        expect(run.status).toBe("running");
        expect(fake.phases()[SPEC_ITEM]).toBe("proposed");

        // The posted plan's marker keeps its tasks, for whichever run takes it up.
        const kept = Arr.findFirst(fake.comments, (comment) =>
          Option.isSome(planMarker.read(comment.body)),
        );

        expect(
          Option.map(
            Option.flatMap(kept, (comment) => planMarker.read(comment.body)),
            (marker) => Option.isSome(Option.fromUndefinedOr(marker.plan)),
          ),
        ).toEqual(Option.some(true));

        // Nobody has answered yet: nothing to start.
        expect(yield* offered(fake)).toEqual([]);

        // A person asks for changes: the spec is work a run may start, and a wake.
        fake.comment("Split the API in two.", "zach");
        const asked = yield* onlyOffered(fake);
        expect([asked.key, asked.signals, mayStart(asked), Plan.resuming(asked)]).toEqual([
          SPEC_ITEM,
          ["changes-requested"],
          true,
          Option.some({ round: 1, answer: "changes-requested" }),
        ]);
      }),
    ENGINE_TIMEOUT,
  );

  effect("a new run takes up an approved plan and makes the epic the plan's marker keeps", () =>
    Effect.gen(function* () {
      const fake = postedEarlier(1, yield* DateTime.now);
      fake.setLabels(ISSUE, [...fake.labelsOf(ISSUE), Plan.LABELS.approved]);

      const finished = yield* runToEnd(planning, fake, yield* onlyOffered(fake));

      expect(finished.status).toBe("done");
      expect(summaryOf(finished)).toBe(`#${ISSUE}: an epic of 2 sub-issues`);
      // No agent drafted it again: the approved plan is the one made.
      expect(fake.requests).toEqual([]);
      expect(fake.phases()[SPEC_ITEM]).toBe("became-epic");
      expect(yield* offered(fake)).toEqual([]);
    }),
  );

  effect(
    "a new run takes up asked-for changes and proposes the next round",
    () =>
      Effect.gen(function* () {
        const fake = postedEarlier(1, yield* DateTime.now);
        fake.comment("Split the API in two.", "zach");
        fake.plans.push(PLAN);

        const resumed = yield* onlyOffered(fake);

        const run = yield* runUntil(planning, fake, resumed, (polled) =>
          Effect.map(listRunWaitsHandler({ runId: polled.id, signal: "approved" }), ({ waits }) =>
            waits.some((wait) => wait.deferred === "approved:plan-2"),
          ),
        );

        expect(run.status).toBe("running");
        // The agent drafted again, with what the person asked for.
        expect(
          fake.requests.some((request) => request.prompt.includes("Split the API in two.")),
        ).toBe(true);
        expect(
          Option.flatMap(Option.fromUndefinedOr(fake.records().get(SPEC_ITEM)), (record) =>
            Option.map(record.data, (data) => data.round),
          ),
        ).toEqual(Option.some(2));
      }),
    ENGINE_TIMEOUT,
  );

  effect("once nobody answered in time, a new run hands the spec to a person", () =>
    Effect.gen(function* () {
      const fake = postedEarlier(1, DateTime.makeUnsafe("2026-01-01T00:00:00Z"));

      const due = yield* onlyOffered(fake);
      expect(Option.fromUndefinedOr(due.signals)).toEqual(Option.none());
      expect(Plan.resuming(due)).toEqual(Option.some({ round: 1, answer: "timeout" }));

      const finished = yield* runToEnd(planning, fake, due);

      expect(finished.status).toBe("needs-human");
      expect(fake.phases()[SPEC_ITEM]).toBe("plan-handed-back");
      expect(fake.labelsOf(ISSUE)).toContain(DEFAULT_LABELS.needsHuman);
      expect(yield* offered(fake)).toEqual([]);
    }),
  );

  effect("an approved plan whose tasks no comment keeps goes to a person, making nothing", () =>
    Effect.gen(function* () {
      const fake = postedEarlier(1, yield* DateTime.now, planMarker.write({ round: 1 }));
      fake.setLabels(ISSUE, [...fake.labelsOf(ISSUE), Plan.LABELS.approved]);

      const finished = yield* runToEnd(planning, fake, yield* onlyOffered(fake));

      expect(finished.status).toBe("needs-human");
      expect(summaryOf(finished)).toContain("isn't kept on the spec any more");
      expect(fake.graph.made.size).toBe(0);
    }),
  );

  effect("taking auto:plan-proposed off changes nothing", () =>
    Effect.gen(function* () {
      const fake = postedEarlier(1, yield* DateTime.now);
      fake.setLabels(ISSUE, [DEFAULT_LABELS.inProgress]);
      fake.comment("Split the API in two.", "zach");

      expect((yield* offered(fake)).map((found) => found.key)).toEqual([SPEC_ITEM]);
    }),
  );
});
