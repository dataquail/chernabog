import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { RunWaitsRepositoryFake } from "../infrastructure/repositories/run-waits.repository-fake.ts";
import { listRunWaitsUseCase } from "./list-run-waits.use-case.ts";
import { releaseRunWaitUseCase } from "./release-run-wait.use-case.ts";

const runId = RunId.make("a");

describe("releaseRunWaitUseCase", () => {
  effect("forgets the wait its signal woke, and keeps the run's others", () =>
    Effect.gen(function* () {
      const [first] = (yield* listRunWaitsUseCase(runId, "pushed")).waits;
      yield* releaseRunWaitUseCase(first);

      expect(
        (yield* listRunWaitsUseCase(runId, "pushed")).waits.map((wait) => wait.deferred),
      ).toEqual(["d2"]);
    }).pipe(
      Effect.provide(
        RunWaitsRepositoryFake([
          RunWaitRoot.make({ runId, signal: "pushed", deferred: "d1", token: "t1" }),
          RunWaitRoot.make({ runId, signal: "pushed", deferred: "d2", token: "t2" }),
        ]),
      ),
    ),
  );
});
