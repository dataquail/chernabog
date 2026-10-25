import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { RunWaitsRepositoryFake } from "../infrastructure/repositories/run-waits.repository-fake.ts";
import { listRunWaitsUseCase } from "./list-run-waits.use-case.ts";

const wait = (runId: string, signal: string, deferred: string) =>
  RunWaitRoot.make({
    runId: RunId.make(runId),
    signal,
    deferred,
    token: "t",
    parkedAt: Option.none(),
  });

describe("listRunWaitsUseCase", () => {
  effect("lists the run's waits on the signal, not another signal's or run's", () =>
    Effect.gen(function* () {
      const { waits } = yield* listRunWaitsUseCase(RunId.make("a"), "pushed");

      expect(waits.map((found) => found.deferred)).toEqual(["d1"]);
    }).pipe(
      Effect.provide(
        RunWaitsRepositoryFake([
          wait("a", "pushed", "d1"),
          wait("a", "approved", "d2"),
          wait("b", "pushed", "d3"),
        ]),
      ),
    ),
  );
});
