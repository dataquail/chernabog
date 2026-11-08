import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { type TokenUsageCursorRoot } from "../../domain/token-usage-cursor/token-usage-cursor.root.ts";
import { TokenUsageCursorsRepository } from "../../domain/token-usage-cursor/token-usage-cursors.repository.ts";

// Sessions' usage cursors, in memory, starting from `cursors`.
export const TokenUsageCursorsRepositoryFake = (cursors: ReadonlyArray<TokenUsageCursorRoot>) =>
  Layer.effect(
    TokenUsageCursorsRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(cursors);

      return TokenUsageCursorsRepository.of({
        findOne: (spec) => Ref.get(store).pipe(Effect.map((stored) => Arr.findFirst(stored, spec))),
        upsertOne: (cursor) =>
          Ref.update(store, (stored) => [
            ...stored.filter(
              (each) => each.adapter !== cursor.adapter || each.sessionId !== cursor.sessionId,
            ),
            cursor,
          ]),
      });
    }),
  );
