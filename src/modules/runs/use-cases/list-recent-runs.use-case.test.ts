import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { listRecentRunsUseCase } from "./list-recent-runs.use-case.ts";

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

describe("listRecentRunsUseCase", () => {
  effect("lists the latest runs, newest first, finished or not", () =>
    Effect.gen(function* () {
      const { runs } = yield* listRecentRunsUseCase(2);

      expect(runs.map((found) => String(found.id))).toEqual(["c", "b"]);
    }).pipe(
      Effect.provide(
        RunsRepositoryFake([
          run("a"),
          run("b", { status: "done", startedAt: "2026-10-21T00:00:00.000Z" }),
          run("c", { startedAt: "2026-10-22T00:00:00.000Z" }),
        ]),
      ),
    ),
  );
});
