import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { type RunNodeEntity } from "../../domain/run/run-node.entity.ts";
import { RunNodesRepository } from "../../domain/run/run-nodes.repository.ts";

// Whether two are the run's one mark of a kind at a node in a round and a lane.
const sameMark = (left: RunNodeEntity, right: RunNodeEntity) =>
  left.runId === right.runId &&
  left.mark === right.mark &&
  left.node === right.node &&
  Equal.equals(left.round, right.round) &&
  Equal.equals(left.lane, right.lane);

// Marks in memory, starting from `marks`.
export const RunNodesRepositoryFake = (marks: ReadonlyArray<RunNodeEntity>) =>
  Layer.effect(
    RunNodesRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(marks);

      return RunNodesRepository.of({
        findMany: (spec) => Ref.get(store).pipe(Effect.map((stored) => stored.filter(spec))),
        insertOne: (mark: RunNodeEntity) => Ref.update(store, (stored) => [...stored, mark]),
        updateOne: (mark: RunNodeEntity) =>
          Ref.update(store, (stored) =>
            stored.map((each) => {
              if (sameMark(each, mark)) {
                return mark;
              }

              return each;
            }),
          ),
      });
    }),
  );
