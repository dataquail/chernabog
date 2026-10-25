import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { RunWaitsRepositoryFake } from "../infrastructure/repositories/run-waits.repository-fake.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { type ActiveRunsFilter, listActiveRunsUseCase } from "./list-active-runs.use-case.ts";

const run = (id: string, fields: Partial<RunRoot> = {}) =>
  RunRoot.make({
    id: RunId.make(id),
    sdkVersion: "0.6.0",
    repo: "demo",
    persona: Option.some("bob"),
    flow: "review",
    itemKey: "pr-1",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    item: Option.none(),
    executionId: Option.none(),
    status: "running",
    currentStep: Option.none(),
    summary: Option.none(),
    startedAt: "2026-10-20T00:00:00.000Z",
    finishedAt: Option.none(),
    ...fields,
  });

const every: ActiveRunsFilter = {
  repo: Option.none(),
  persona: Option.none(),
  flow: Option.none(),
};

const stores = Layer.mergeAll(
  RunsRepositoryFake([
    run("a"),
    run("b", { persona: Option.none(), startedAt: "2026-10-21T00:00:00.000Z" }),
    run("c", { flow: "implement", startedAt: "2026-10-22T00:00:00.000Z" }),
    run("d", { status: "done", finishedAt: Option.some("2026-10-21T00:00:00.000Z") }),
  ]),
  RunWaitsRepositoryFake([
    RunWaitRoot.make({
      runId: RunId.make("b"),
      signal: "pushed",
      deferred: "d",
      token: "t",
      parkedAt: Option.none(),
    }),
  ]),
);

describe("listActiveRunsUseCase", () => {
  effect("lists the runs in flight, oldest first, saying which are parked", () =>
    Effect.gen(function* () {
      const { runs } = yield* listActiveRunsUseCase(every);

      expect(runs.map((active) => [String(active.id), active.parked])).toEqual([
        ["a", false],
        ["b", true],
        ["c", false],
      ]);
    }).pipe(Effect.provide(stores)),
  );

  effect("narrows them by repo, persona and flow", () =>
    Effect.gen(function* () {
      const ids = (filter: typeof every) =>
        listActiveRunsUseCase(filter).pipe(
          Effect.map(({ runs }) => runs.map((active) => String(active.id))),
        );

      expect(yield* ids({ ...every, persona: Option.some(Option.none()) })).toEqual(["b"]);
      expect(yield* ids({ ...every, persona: Option.some(Option.some("bob")) })).toEqual([
        "a",
        "c",
      ]);
      expect(yield* ids({ ...every, flow: Option.some("implement") })).toEqual(["c"]);
      expect(yield* ids({ ...every, repo: Option.some("other") })).toEqual([]);
    }).pipe(Effect.provide(stores)),
  );
});
