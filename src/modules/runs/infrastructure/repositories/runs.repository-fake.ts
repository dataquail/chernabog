import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Ref from "effect/Ref";

import { type Specification } from "../../../../kernel/specification.ts";
import { type RunRoot } from "../../domain/run/run.root.ts";
import { RunsRepository } from "../../domain/run/runs.repository.ts";

const byStart = Order.mapInput(Order.String, (run: RunRoot) => run.startedAt);

// Runs in memory, starting from `runs`. Like the live repository, a save never
// rewrites a run that ended with another ending.
export const RunsRepositoryFake = (runs: ReadonlyArray<RunRoot>) =>
  Layer.effect(
    RunsRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(runs);

      // The runs a spec holds of, oldest first, as the live repository reads them.
      const findMany = (spec: Specification<RunRoot>) =>
        Ref.get(store).pipe(Effect.map((stored) => Arr.sort(stored.filter(spec), byStart)));

      const findOne = (spec: Specification<RunRoot>) => findMany(spec).pipe(Effect.map(Arr.head));

      const writable = (stored: RunRoot, run: RunRoot) =>
        Option.isNone(stored.finishedAt) ||
        Option.getOrNull(stored.finishedAt) === Option.getOrNull(run.finishedAt);

      const upsertOne = (run: RunRoot) =>
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

      return RunsRepository.of({ findOne, findMany, upsertOne });
    }),
  );
