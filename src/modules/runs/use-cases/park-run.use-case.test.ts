import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunWaitsRepositoryFake } from "../infrastructure/repositories/run-waits.repository-fake.ts";
import { listRunWaitsUseCase } from "./list-run-waits.use-case.ts";
import { parkRunUseCase } from "./park-run.use-case.ts";

describe("parkRunUseCase", () => {
  effect("parks the run on its signal, until it's released, and keeps when it parked", () =>
    Effect.gen(function* () {
      const runId = RunId.make("a");
      const parked = yield* parkRunUseCase({ runId, signal: "pushed", deferred: "d", token: "t" });

      expect(Option.isSome(parked.parkedAt)).toBe(true);

      expect((yield* listRunWaitsUseCase(runId, "pushed")).waits.map((wait) => wait.token)).toEqual(
        ["t"],
      );
    }).pipe(Effect.provide(RunWaitsRepositoryFake([]))),
  );
});
