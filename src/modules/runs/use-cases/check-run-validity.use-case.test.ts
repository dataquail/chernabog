import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { type ValidityQuestion } from "../domain/run/work-item.value-object.ts";
import { type FakeFlow, FlowsClientFake } from "../infrastructure/clients/flows.client-fake.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { RunValidity } from "./check-run-validity.result.ts";
import { checkRunValidityUseCase } from "./check-run-validity.use-case.ts";

const work = { key: "pr-1", data: { pullRequest: 1 } };

const run = (id: string, fields: Partial<RunRoot> = {}) =>
  RunRoot.make({
    id: RunId.make(id),
    coreVersion: "0.6.0",
    repo: "demo",
    persona: Option.some("bob"),
    flow: "review",
    itemKey: "pr-1",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    item: Option.some(work),
    executionId: Option.some(`execution-${id}`),
    status: "running",
    currentStep: Option.some("await-closed:approved"),
    summary: Option.none(),
    startedAt: "2026-10-20T00:00:00.000Z",
    finishedAt: Option.none(),
    ...fields,
  });

const runtime = (runs: ReadonlyArray<RunRoot>, flow: FakeFlow) =>
  Layer.mergeAll(RunsRepositoryFake(runs), FlowsClientFake({ "demo/review": flow }));

const checking = (id: string) => checkRunValidityUseCase(RunId.make(id));

describe("checkRunValidityUseCase", () => {
  const asked: Array<ValidityQuestion> = [];

  effect("asks the run's flow about its item, as the run, and says it's gone", () =>
    Effect.gen(function* () {
      const found = yield* checking("a");

      expect(found).toEqual(RunValidity.cases.Gone.make({ reason: "#1 was closed" }));
      expect(asked).toEqual([
        {
          runId: RunId.make("a"),
          executionId: "execution-a",
          item: work,
          pullRequest: Option.some(1),
        },
      ]);
    }).pipe(
      Effect.provide(
        runtime([run("a", { pullRequest: Option.some(1) })], {
          items: [],
          validity: { valid: false, reason: "#1 was closed" },
          asked,
        }),
      ),
    ),
  );

  effect("says a run whose item is there is valid", () =>
    Effect.gen(function* () {
      expect((yield* checking("a"))._tag).toBe("Valid");
    }).pipe(Effect.provide(runtime([run("a")], { items: [], validity: { valid: true } }))),
  );

  effect("a check that fails is not gone", () =>
    Effect.gen(function* () {
      expect(yield* checking("a")).toEqual(
        RunValidity.cases.CheckFailed.make({ message: "rate limited" }),
      );
    }).pipe(
      Effect.provide(
        runtime([run("a")], {
          items: [],
          validity: { valid: false, reason: "never read" },
          validityFails: "rate limited",
        }),
      ),
    ),
  );

  const unasked: Array<ValidityQuestion> = [];

  effect(
    "checks nothing for a flow with no stillValid, a run that ended, or one with no item or execution",
    () =>
      Effect.gen(function* () {
        const tags = [];

        for (const id of ["no-check", "ended", "no-item", "unexecuted", "unknown"]) {
          tags.push((yield* checking(id))._tag);
        }

        expect(tags).toEqual(["Unchecked", "Unchecked", "Unchecked", "Unchecked", "Unchecked"]);
        expect(unasked.map((question) => question.runId)).toEqual([RunId.make("no-check")]);
      }).pipe(
        Effect.provide(
          runtime(
            [
              run("no-check"),
              run("ended", { status: "done", finishedAt: Option.some("2026-10-21T00:00:00Z") }),
              run("no-item", { item: Option.none() }),
              run("unexecuted", { executionId: Option.none() }),
            ],
            { items: [], asked: unasked },
          ),
        ),
      ),
  );
});
