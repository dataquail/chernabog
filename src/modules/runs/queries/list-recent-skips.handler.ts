import * as Effect from "effect/Effect";

import { SkipsRepository } from "../domain/ports/repositories/skips.repository.ts";
import { SkipView } from "../domain/skip/skip-view.value-object.ts";
import { type ListRecentSkipsPayload, SkipList } from "./list-recent-skips.query.ts";

export const listRecentSkipsHandler = Effect.fn("listRecentSkipsHandler")(function* ({
  latest,
}: ListRecentSkipsPayload) {
  const skips = yield* (yield* SkipsRepository).findAll(latest);

  return SkipList.make({ skips: skips.map((skip) => SkipView.make({ ...skip })) });
});
