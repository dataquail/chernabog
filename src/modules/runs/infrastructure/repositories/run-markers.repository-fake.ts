import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import {
  type MarkerQuery,
  RunMarkersRepository,
} from "../../domain/ports/repositories/run-markers.repository.ts";
import { type RunMarkerRoot } from "../../domain/run-marker/run-marker.root.ts";
import { RunMarkerRootOps } from "../../domain/run-marker/run-marker.root-ops.ts";

const matches = (query: MarkerQuery) => (marker: RunMarkerRoot) =>
  Option.match(query.runId, { onNone: () => true, onSome: (id) => marker.runId === id }) &&
  Option.match(query.status, { onNone: () => true, onSome: (status) => marker.status === status });

// Markers in memory, in the order they were held, starting from `markers`.
export const RunMarkersRepositoryFake = (markers: ReadonlyArray<RunMarkerRoot>) =>
  Layer.effect(
    RunMarkersRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(markers);

      return RunMarkersRepository.of({
        findAll: (query) =>
          Ref.get(store).pipe(Effect.map((stored) => stored.filter(matches(query)))),
        save: (marker) =>
          Ref.update(store, (stored) => {
            const at = stored.findIndex((known) => RunMarkerRootOps.same(known, marker));

            if (at === -1) {
              return [...stored, marker];
            }

            return stored.with(at, marker);
          }),
        remove: (marker) =>
          Ref.update(store, (stored) =>
            stored.filter((known) => !RunMarkerRootOps.same(known, marker)),
          ),
      });
    }),
  );
