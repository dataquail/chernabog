import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";

import { SkipSpecifications } from "../domain/skip/skip.specification.ts";
import { SkipView } from "../domain/skip/skip-view.value-object.ts";
import { SkipsRepository } from "../domain/skip/skips.repository.ts";
import { type ListRecentSkipsPayload, SkipList } from "./list-recent-skips.query.ts";

export const listRecentSkipsHandler = Effect.fn("listRecentSkipsHandler")(function* ({
  latest,
}: ListRecentSkipsPayload) {
  // The latest `latest` skips, newest first. A limit is no predicate, so a
  // spec can't say it: this read leaves the repository with the queries task
  // (#283), which reads state.db directly.
  const skips = Arr.take(yield* (yield* SkipsRepository).findMany(SkipSpecifications.all), latest);

  return SkipList.make({ skips: skips.map((skip) => SkipView.make({ ...skip })) });
});
