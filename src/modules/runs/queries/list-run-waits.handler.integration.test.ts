import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../test/sqlite.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
import { RunWaitRoot } from "../domain/run-wait/run-wait.root.ts";
import { RunWaitsRepositoryLive } from "../infrastructure/repositories/run-waits.repository-live.ts";
import { listRunWaitsHandler } from "./list-run-waits.handler.ts";

const wait = (runId: string, signal: string, deferred: string) =>
  RunWaitRoot.make({
    runId: RunId.make(runId),
    signal,
    deferred,
    token: "t",
    parkedAt: Option.none(),
  });

describe("listRunWaitsHandler", () => {
  effect("lists the run's waits on the signal, not another signal's or run's", () =>
    Effect.gen(function* () {
      const repository = yield* RunWaitsRepository;
      yield* repository.save(wait("a", "pushed", "d1"));
      yield* repository.save(wait("a", "approved", "d2"));
      yield* repository.save(wait("b", "pushed", "d3"));

      const { waits } = yield* listRunWaitsHandler({ runId: RunId.make("a"), signal: "pushed" });

      expect(waits.map((found) => found.deferred)).toEqual(["d1"]);
    }).pipe(Effect.provide(RunWaitsRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void))))),
  );
});
