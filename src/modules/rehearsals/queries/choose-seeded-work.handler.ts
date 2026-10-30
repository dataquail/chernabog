import * as Effect from "effect/Effect";

import { ScenarioRootOps } from "../domain/scenario/scenario.root-ops.ts";
import { type ChooseSeededWorkPayload, SeededWork } from "./choose-seeded-work.query.ts";

export const chooseSeededWorkHandler = Effect.fn("chooseSeededWorkHandler")(function* (
  query: ChooseSeededWorkPayload,
) {
  return yield* Effect.sync(() =>
    SeededWork.make({
      keys: query.keys.filter((key) => ScenarioRootOps.isSeeded(query.seeded, key)),
    }),
  );
});
