import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Ref from "effect/Ref";

import { type RunId } from "../../../../kernel/run-id.id.ts";
import { type RunsQuery, RunsRepository } from "../../domain/ports/repositories/runs.repository.ts";
import { type RunRoot } from "../../domain/run/run.root.ts";

const byStart = Order.mapInput(Order.String, (run: RunRoot) => run.startedAt);

// Runs in memory, starting from `runs`. Like the live repository, a save never
// rewrites a run that ended with another ending.
export const RunsRepositoryFake = (runs: ReadonlyArray<RunRoot>) =>
  Layer.effect(
    RunsRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(runs);

      const findOne = (id: RunId) =>
        Ref.get(store).pipe(Effect.map((stored) => Arr.findFirst(stored, (run) => run.id === id)));

      const findAll = (query: RunsQuery) =>
        Ref.get(store).pipe(
          Effect.map((stored) => {
            if ("running" in query) {
              return Arr.sort(
                stored.filter((run) => run.status === "running"),
                byStart,
              );
            }

            if ("latest" in query) {
              return Arr.take(Arr.sort(stored, Order.flip(byStart)), query.latest);
            }

            return Arr.sort(
              stored.filter((run) => run.repo === query.repo),
              byStart,
            );
          }),
        );

      const writable = (stored: RunRoot, run: RunRoot) =>
        Option.isNone(stored.finishedAt) ||
        Option.getOrNull(stored.finishedAt) === Option.getOrNull(run.finishedAt);

      const save = (run: RunRoot) =>
        Ref.update(store, (stored) => {
          const found = Arr.findFirst(stored, (known) => known.id === run.id);

          if (Option.isNone(found)) {
            return [...stored, run];
          }

          if (!writable(found.value, run)) {
            return stored;
          }

          return [...stored.filter((known) => known.id !== run.id), run];
        });

      return RunsRepository.of({ findOne, findAll, save });
    }),
  );
