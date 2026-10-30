import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { findRunHandler } from "../queries/find-run.handler.ts";
import { adoptImplicitRunsUseCase } from "./adopt-implicit-runs.use-case.ts";

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

describe("adoptImplicitRunsUseCase", () => {
  effect("gives a repo's runs from before personas the persona, and leaves others alone", () =>
    Effect.gen(function* () {
      const adopted = yield* adoptImplicitRunsUseCase("demo", "alice");

      const personaOf = (id: string) =>
        findRunHandler({ runId: RunId.make(id) }).pipe(
          Effect.map((found) => Option.flatMap(found.run, (known) => known.persona)),
        );

      expect(adopted.runs).toEqual([RunId.make("implicit")]);
      expect(yield* personaOf("implicit")).toEqual(Option.some("alice"));
      expect(yield* personaOf("other-repo")).toEqual(Option.none());
      expect(yield* personaOf("as-bob")).toEqual(Option.some("bob"));
    }).pipe(
      Effect.provide(
        RunsRepositoryFake([
          run("implicit", { persona: Option.none() }),
          run("other-repo", { persona: Option.none(), repo: "other" }),
          run("as-bob", { itemKey: "pr-2" }),
        ]),
      ),
    ),
  );
});
