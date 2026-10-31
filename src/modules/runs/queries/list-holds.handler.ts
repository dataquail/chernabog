import * as Effect from "effect/Effect";

import { HoldList, HoldView } from "../domain/holds/hold-view.value-object.ts";
import { HoldsRepository } from "../domain/holds/holds.repository.ts";
import { HoldsSpecifications } from "../domain/holds/holds.specification.ts";

export const listHoldsHandler = Effect.fn("listHoldsHandler")(function* () {
  const flows = yield* (yield* HoldsRepository).findMany(HoldsSpecifications.all);

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
