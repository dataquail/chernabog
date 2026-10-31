import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { type RunMarkerRoot } from "../../domain/run-marker/run-marker.root.ts";
import { RunMarkerRootOps } from "../../domain/run-marker/run-marker.root-ops.ts";
import { RunMarkersRepository } from "../../domain/run-marker/run-markers.repository.ts";

// Markers in memory, in the order they were held, starting from `markers`.
export const RunMarkersRepositoryFake = (markers: ReadonlyArray<RunMarkerRoot>) =>
  Layer.effect(
    RunMarkersRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(markers);

      return RunMarkersRepository.of({
        findMany: (spec) => Ref.get(store).pipe(Effect.map((stored) => stored.filter(spec))),
        upsertOne: (marker) =>
          Ref.update(store, (stored) => {
            const at = stored.findIndex((known) => RunMarkerRootOps.same(known, marker));

            if (at === -1) {
              return [...stored, marker];
            }

            return stored.with(at, marker);
          }),
        deleteOne: (marker) =>
          Ref.update(store, (stored) =>
            stored.filter((known) => !RunMarkerRootOps.same(known, marker)),
          ),
      });
    }),
  );
