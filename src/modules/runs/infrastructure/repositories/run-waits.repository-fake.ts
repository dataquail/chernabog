import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { type RunWaitRoot } from "../../domain/run-wait/run-wait.root.ts";
import { RunWaitsRepository } from "../../domain/run-wait/run-waits.repository.ts";

const same = (left: RunWaitRoot, right: RunWaitRoot) =>
  left.runId === right.runId && left.deferred === right.deferred;

// Waits in memory, starting from `waits`.
export const RunWaitsRepositoryFake = (waits: ReadonlyArray<RunWaitRoot>) =>
  Layer.effect(
    RunWaitsRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(waits);

      return RunWaitsRepository.of({
        findMany: (spec) => Ref.get(store).pipe(Effect.map((stored) => stored.filter(spec))),
        upsertOne: (wait: RunWaitRoot) =>
          Ref.update(store, (stored) => [...stored.filter((known) => !same(known, wait)), wait]),
        deleteOne: (wait: RunWaitRoot) =>
          Ref.update(store, (stored) => stored.filter((known) => !same(known, wait))),
      });
    }),
  );
