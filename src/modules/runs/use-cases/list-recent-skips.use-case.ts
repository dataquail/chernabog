import * as Effect from "effect/Effect";

import { SkipsRepository } from "../domain/ports/repositories/skips.repository.ts";
import { SkipList, SkipView } from "./skip.result.ts";

// The latest skips, newest first.
export const listRecentSkipsUseCase = Effect.fn("listRecentSkipsUseCase")(function* (
  latest: number,
) {
  const skips = yield* (yield* SkipsRepository).findAll(latest);

  return SkipList.make({ skips: skips.map((skip) => SkipView.make({ ...skip })) });
});
