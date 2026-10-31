import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../test/sqlite.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { RunsRepositoryLive } from "../infrastructure/repositories/runs.repository-live.ts";
import { listRecentRunsHandler } from "./list-recent-runs.handler.ts";

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

describe("listRecentRunsHandler", () => {
  effect("lists the latest runs, newest first, finished or not", () =>
    Effect.gen(function* () {
      const repository = yield* RunsRepository;
      yield* repository.upsertOne(run("a"));
      yield* repository.upsertOne(
        run("b", { status: "done", startedAt: "2026-10-21T00:00:00.000Z" }),
      );
      yield* repository.upsertOne(run("c", { startedAt: "2026-10-22T00:00:00.000Z" }));

      const { runs } = yield* listRecentRunsHandler({ latest: 2 });

      expect(runs.map((found) => String(found.id))).toEqual(["c", "b"]);
    }).pipe(Effect.provide(RunsRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void))))),
  );
});
