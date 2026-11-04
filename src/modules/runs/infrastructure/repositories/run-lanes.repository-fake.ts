import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { type RunLaneEntity } from "../../domain/run/run-lane.entity.ts";
import { RunLanesRepository } from "../../domain/run/run-lanes.repository.ts";

// Whether two are the same lane of a run.
const sameLane = (left: RunLaneEntity, right: RunLaneEntity) =>
  left.runId === right.runId && left.lane === right.lane;

// Lanes in memory, starting from `lanes`.
export const RunLanesRepositoryFake = (lanes: ReadonlyArray<RunLaneEntity>) =>
  Layer.effect(
    RunLanesRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(lanes);

      return RunLanesRepository.of({
        findMany: (spec) => Ref.get(store).pipe(Effect.map((stored) => stored.filter(spec))),
        upsertOne: (lane: RunLaneEntity) =>
          Ref.update(store, (stored) => {
            if (!stored.some((each) => sameLane(each, lane))) {
              return [...stored, lane];
            }

            return stored.map((each) => {
              if (sameLane(each, lane)) {
                return lane;
              }

              return each;
            });
          }),
      });
    }),
  );
