import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { findActiveRunHandler } from "./find-active-run.handler.ts";

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

const wanted = { repo: "demo", persona: Option.some("bob"), flow: "review", itemKey: "pr-1" };

describe("findActiveRunHandler", () => {
  effect("finds the persona's run in flight for the item, and none for another persona", () =>
    Effect.gen(function* () {
      const found = yield* findActiveRunHandler(wanted);

      expect(Option.map(found.run, (active) => String(active.id))).toEqual(Option.some("b"));
      expect(
        (yield* findActiveRunHandler({ ...wanted, persona: Option.some("alice") })).run,
      ).toEqual(Option.none());
    }).pipe(
      Effect.provide(
        RunsRepositoryFake([run("a", { status: "done", finishedAt: Option.some("x") }), run("b")]),
      ),
    ),
  );
});
