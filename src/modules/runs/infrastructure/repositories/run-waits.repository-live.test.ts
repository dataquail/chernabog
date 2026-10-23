import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../../test/sqlite.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunWaitsRepository } from "../../domain/ports/repositories/run-waits.repository.ts";
import { RunWaitRoot } from "../../domain/run-wait/run-wait.root.ts";
import { RunWaitsRepositoryLive } from "./run-waits.repository-live.ts";

const wait = (runId: string, deferred: string, token: string) =>
  RunWaitRoot.make({ runId: RunId.make(runId), signal: "pushed", deferred, token });

describe("RunWaitsRepositoryLive", () => {
  effect("saves waits, replacing a run's wait on the same deferred, and removes them", () =>
    Effect.gen(function* () {
      const waits = yield* RunWaitsRepository;
      yield* waits.save(wait("a", "d1", "t1"));
      yield* waits.save(wait("a", "d1", "t2"));
      yield* waits.save(wait("a", "d2", "t3"));
      yield* waits.save(wait("b", "d1", "t4"));

      expect(
        (yield* waits.findAll(Option.some(RunId.make("a")))).map((found) => found.token),
      ).toEqual(["t2", "t3"]);
      expect((yield* waits.findAll(Option.none())).length).toBe(3);

      yield* waits.remove(wait("a", "d1", "t2"));
      expect(
        (yield* waits.findAll(Option.some(RunId.make("a")))).map((found) => found.deferred),
      ).toEqual(["d2"]);
    }).pipe(Effect.provide(RunWaitsRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void))))),
  );
});
