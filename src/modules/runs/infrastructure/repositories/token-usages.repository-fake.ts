import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { type TokenUsageRoot } from "../../domain/token-usage/token-usage.root.ts";
import { TokenUsagesRepository } from "../../domain/token-usage/token-usages.repository.ts";

// What runs' agent calls spent, in memory, starting from `usages`.
export const TokenUsagesRepositoryFake = (usages: ReadonlyArray<TokenUsageRoot>) =>
  Layer.effect(
    TokenUsagesRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(usages);

      return TokenUsagesRepository.of({
        findMany: (spec) => Ref.get(store).pipe(Effect.map((stored) => stored.filter(spec))),
        insertMany: (added) => Ref.update(store, (stored) => [...stored, ...added]),
      });
    }),
  );
