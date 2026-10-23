import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Order from "effect/Order";
import * as Ref from "effect/Ref";

import { SkipsRepository } from "../../domain/ports/repositories/skips.repository.ts";
import { type SkipRoot } from "../../domain/skip/skip.root.ts";

const newestFirst = Order.flip(Order.mapInput(Order.String, (skip: SkipRoot) => skip.at));

// Skips in memory, starting from `skips`.
export const SkipsRepositoryFake = (skips: ReadonlyArray<SkipRoot>) =>
  Layer.effect(
    SkipsRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(skips);

      return SkipsRepository.of({
        findAll: (latest: number) =>
          Ref.get(store).pipe(
            Effect.map((stored) => Arr.take(Arr.sort(stored, newestFirst), latest)),
          ),
        save: (skip: SkipRoot) => Ref.update(store, (stored) => [...stored, skip]),
      });
    }),
  );
