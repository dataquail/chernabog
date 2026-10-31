import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { SkipsRepository } from "../domain/ports/repositories/skips.repository.ts";
import { SkipRoot } from "../domain/skip/skip.root.ts";
import { SkipView } from "../domain/skip/skip-view.value-object.ts";
import { type RecordSkipPayload } from "./record-skip.command.ts";

export const recordSkipHandler = Effect.fn("recordSkipHandler")(function* (
  skipping: RecordSkipPayload,
) {
  const skip = SkipRoot.make({ ...skipping, at: DateTime.formatIso(yield* DateTime.now) });
  yield* (yield* SkipsRepository).save(skip);

  return SkipView.make({ ...skip });
});
