import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../test/sqlite.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { RunWaitsRepositoryLive } from "../infrastructure/repositories/run-waits.repository-live.ts";
import { RunsRepositoryLive } from "../infrastructure/repositories/runs.repository-live.ts";
import { listActiveRunsHandler } from "./list-active-runs.handler.ts";
import { type ListActiveRunsPayload } from "./list-active-runs.query.ts";

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
    item: Option.none(),
    executionId: Option.none(),
    status: "running",
    currentStep: Option.none(),
    summary: Option.none(),
    startedAt: "2026-10-20T00:00:00.000Z",
    finishedAt: Option.none(),
    ...fields,
  });

const every: ListActiveRunsPayload = {
  repo: Option.none(),
  persona: Option.none(),
  flow: Option.none(),
};

// state.db with four runs, one of them done, and run b waiting on a signal.
const stores = Layer.effectDiscard(
  Effect.gen(function* () {
    const runs = yield* RunsRepository;
    yield* runs.save(run("a"));
    yield* runs.save(run("b", { persona: Option.none(), startedAt: "2026-10-21T00:00:00.000Z" }));
    yield* runs.save(run("c", { flow: "implement", startedAt: "2026-10-22T00:00:00.000Z" }));
    yield* runs.save(
      run("d", { status: "done", finishedAt: Option.some("2026-10-21T00:00:00.000Z") }),
    );
    yield* (yield* RunWaitsRepository).save(
      RunWaitRoot.make({
        runId: RunId.make("b"),
        signal: "pushed",
        deferred: "d",
        token: "t",
        parkedAt: Option.none(),
      }),
    );
  }),
).pipe(
  Layer.provideMerge(Layer.mergeAll(RunsRepositoryLive, RunWaitsRepositoryLive)),
  Layer.provide(sqliteAfter(Effect.void)),
);

describe("listActiveRunsHandler", () => {
  effect("lists the runs in flight, oldest first, saying which are parked", () =>
    Effect.gen(function* () {
      const { runs } = yield* listActiveRunsHandler(every);

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
        listActiveRunsHandler(filter).pipe(
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
