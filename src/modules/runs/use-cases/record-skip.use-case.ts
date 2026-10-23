import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type Persona } from "../../../kernel/persona.value-object.ts";
import { SkipsRepository } from "../domain/ports/repositories/skips.repository.ts";
import { SkipRoot } from "../domain/skip/skip.root.ts";
import { SkipView } from "./skip.result.ts";

// What a tick skipped, and why.
export type Skipping = {
  readonly repo: string;
  readonly persona: Persona;
  readonly flow: string;
  readonly itemKey: Option.Option<string>;
  readonly reason: string;
};

// Records why a tick of a persona's flow started nothing, for `status` to show.
export const recordSkipUseCase = Effect.fn("recordSkipUseCase")(function* (skipping: Skipping) {
  const skip = SkipRoot.make({ ...skipping, at: DateTime.formatIso(yield* DateTime.now) });
  yield* (yield* SkipsRepository).save(skip);

  return SkipView.make({ ...skip });
});
