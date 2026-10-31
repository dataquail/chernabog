import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { type ReloadRoot } from "../../domain/reload/reload.root.ts";
import { ReloadsRepository } from "../../domain/reload/reloads.repository.ts";

// Reloads in memory, starting from `records`.
export const ReloadsRepositoryFake = (records: ReadonlyArray<ReloadRoot>) =>
  Layer.effect(
    ReloadsRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(records);

      return ReloadsRepository.of({
        findOne: (spec) =>
          Ref.get(store).pipe(Effect.map((stored) => Option.fromUndefinedOr(stored.find(spec)))),
        upsertOne: (record: ReloadRoot) =>
          Ref.update(store, (stored) => [
            ...stored.filter((known) => known.repo !== record.repo),
            record,
          ]),
      });
    }),
  );
