import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { type RunId } from "../../../../kernel/run-id.id.ts";
import { RunWaitsRepository } from "../../domain/ports/repositories/run-waits.repository.ts";
import { type RunWaitRoot } from "../../domain/run-wait/run-wait.root.ts";

const same = (left: RunWaitRoot, right: RunWaitRoot) =>
  left.runId === right.runId && left.deferred === right.deferred;

// Waits in memory, starting from `waits`.
export const RunWaitsRepositoryFake = (waits: ReadonlyArray<RunWaitRoot>) =>
  Layer.effect(
    RunWaitsRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(waits);

      return RunWaitsRepository.of({
        findAll: (runId: Option.Option<RunId>) =>
          Ref.get(store).pipe(
            Effect.map((stored) =>
              stored.filter((wait) =>
                Option.match(runId, {
                  onNone: () => true,
                  onSome: (id) => wait.runId === id,
                }),
              ),
            ),
          ),
        save: (wait: RunWaitRoot) =>
          Ref.update(store, (stored) => [...stored.filter((known) => !same(known, wait)), wait]),
        remove: (wait: RunWaitRoot) =>
          Ref.update(store, (stored) => stored.filter((known) => !same(known, wait))),
      });
    }),
  );
