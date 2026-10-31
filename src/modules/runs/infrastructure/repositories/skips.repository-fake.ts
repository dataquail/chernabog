import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Order from "effect/Order";
import * as Ref from "effect/Ref";

import { type SkipRoot } from "../../domain/skip/skip.root.ts";
import { SkipsRepository } from "../../domain/skip/skips.repository.ts";

const newestFirst = Order.flip(Order.mapInput(Order.String, (skip: SkipRoot) => skip.at));

// Skips in memory, starting from `skips`.
export const SkipsRepositoryFake = (skips: ReadonlyArray<SkipRoot>) =>
  Layer.effect(
    SkipsRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(skips);

      return SkipsRepository.of({
        findMany: (spec) =>
          Ref.get(store).pipe(Effect.map((stored) => Arr.sort(stored.filter(spec), newestFirst))),
        insertOne: (skip: SkipRoot) => Ref.update(store, (stored) => [...stored, skip]),
      });
    }),
  );
