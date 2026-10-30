import * as Effect from "effect/Effect";

import { HoldView } from "../domain/holds/hold-view.value-object.ts";
import { HoldsRepository } from "../domain/ports/repositories/holds.repository.ts";
import { HoldList } from "./list-holds.query.ts";

export const listHoldsHandler = Effect.fn("listHoldsHandler")(function* () {
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
