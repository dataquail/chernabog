import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { type RunSpokeRoot } from "../../domain/run-spoke/run-spoke.root.ts";
import { RunSpokesRepository } from "../../domain/run-spoke/run-spokes.repository.ts";

// Spokes' records in memory, starting from `spokes`.
export const RunSpokesRepositoryFake = (spokes: ReadonlyArray<RunSpokeRoot>) =>
  Layer.effect(
    RunSpokesRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(spokes);

      const findMany: RunSpokesRepository["Service"]["findMany"] = (spec) =>
        Ref.get(store).pipe(Effect.map((stored) => stored.filter(spec)));

      return RunSpokesRepository.of({
        findOne: (spec) => Effect.map(findMany(spec), Arr.head),
        findMany,
        upsertOne: (spoke) =>
          Ref.update(store, (stored) => [
            ...stored.filter((known) => known.runId !== spoke.runId),
            spoke,
          ]),
        deleteOne: (spoke) =>
          Ref.update(store, (stored) => stored.filter((known) => known.runId !== spoke.runId)),
      });
    }),
  );
