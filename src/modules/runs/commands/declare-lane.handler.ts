import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RunLaneEntity } from "../domain/run/run-lane.entity.ts";
import { RunLaneSpecifications } from "../domain/run/run-lane.specification.ts";
import { RunLanesRepository } from "../domain/run/run-lanes.repository.ts";
import { type DeclareLanePayload } from "./declare-lane.command.ts";

export const declareLaneHandler = Effect.fn("declareLaneHandler")(
  function* ({ lane, needs, runId }: DeclareLanePayload) {
    const lanes = yield* RunLanesRepository;

    const found = Arr.head(yield* lanes.findMany(RunLaneSpecifications.named(runId, lane)));

    const before = Option.match(found, {
      onNone: (): ReadonlyArray<string> => [],
      onSome: (known) => known.needs,
    });

    // A lane never waits on itself.
    const after = Arr.dedupe([...before, ...needs.filter((need) => need !== lane)]);

    if (Option.isSome(found) && after.length === before.length) {
      return;
    }

    yield* lanes.upsertOne(RunLaneEntity.make({ runId, lane, needs: after }));
  },
  withUnitOfWork,
  // state.db is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
