import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { BUNDLED_SDK_VERSION, supportedRange } from "../../../kernel/sdk-support.value-object.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { listUnsupportedRunsUseCase } from "./list-unsupported-runs.use-case.ts";

const run = (id: string, fields: Partial<RunRoot> = {}) =>
  RunRoot.make({
    id: RunId.make(id),
    sdkVersion: BUNDLED_SDK_VERSION,
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

describe("listUnsupportedRunsUseCase", () => {
  effect("lists the runs in flight under an SDK this binary doesn't run, naming both", () =>
    Effect.gen(function* () {
      const { runs } = yield* listUnsupportedRunsUseCase();

      expect(runs.map((found) => [String(found.run.id), found.reason])).toEqual([
        [
          "old",
          `it started under @chernabog/sdk 0.5.2, and this chernabog runs @chernabog/sdk ${supportedRange}, so it wasn't resumed`,
        ],
      ]);
    }).pipe(
      Effect.provide(
        RunsRepositoryFake([
          run("old", { sdkVersion: "0.5.2" }),
          run("current"),
          run("ended", {
            sdkVersion: "0.5.2",
            status: "done",
            finishedAt: Option.some("2026-10-21T00:00:00.000Z"),
          }),
        ]),
      ),
    ),
  );
});
