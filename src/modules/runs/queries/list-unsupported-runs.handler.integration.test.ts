import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../test/sqlite.ts";
import { BUNDLED_CORE_VERSION, providedRange } from "../../../kernel/core-support.value-object.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { RunsRepositoryLive } from "../infrastructure/repositories/runs.repository-live.ts";
import { listUnsupportedRunsHandler } from "./list-unsupported-runs.handler.ts";

const run = (id: string, fields: Partial<RunRoot> = {}) =>
  RunRoot.make({
    id: RunId.make(id),
    coreVersion: BUNDLED_CORE_VERSION,
    repo: "demo",
    persona: Option.some("bob"),
    flow: "review",
    itemKey: `pr-${id}`,
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

describe("listUnsupportedRunsHandler", () => {
  effect("lists the runs in flight under an SDK this binary doesn't run, naming both", () =>
    Effect.gen(function* () {
      const repository = yield* RunsRepository;
      yield* repository.upsertOne(run("old", { coreVersion: "0.5.2" }));
      yield* repository.upsertOne(run("current"));
      yield* repository.upsertOne(
        run("ended", {
          coreVersion: "0.5.2",
          status: "done",
          finishedAt: Option.some("2026-10-21T00:00:00.000Z"),
        }),
      );

      const { runs } = yield* listUnsupportedRunsHandler();

      expect(runs.map((found) => [String(found.run.id), found.reason])).toEqual([
        [
          "old",
          `it started under @chernabog/core 0.5.2, and this chernabog provides @chernabog/core ${providedRange}, so it wasn't resumed`,
        ],
      ]);
    }).pipe(Effect.provide(RunsRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void))))),
  );
});
