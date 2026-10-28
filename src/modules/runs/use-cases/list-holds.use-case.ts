import * as Effect from "effect/Effect";

import { HoldsRepository } from "../domain/ports/repositories/holds.repository.ts";
import { HoldList, HoldView } from "./hold.result.ts";

// The items every flow's latest tick held, and why, one view per item.
export const listHoldsUseCase = Effect.fn("listHoldsUseCase")(function* () {
  const flows = yield* (yield* HoldsRepository).findAll;

  return HoldList.make({
    holds: flows.flatMap((flow) =>
      flow.items.map((item) =>
        HoldView.make({
          repo: flow.repo,
          persona: flow.persona,
          flow: flow.flow,
          itemKey: item.itemKey,
          reason: item.reason,
          at: flow.at,
        }),
      ),
    ),
  });
});
