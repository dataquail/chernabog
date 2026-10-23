import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { type RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { ReloadsRepository } from "../../domain/ports/repositories/reloads.repository.ts";
import { type ReloadRoot } from "../../domain/reload/reload.root.ts";

// Reloads in memory, starting from `records`.
export const ReloadsRepositoryFake = (records: ReadonlyArray<ReloadRoot>) =>
  Layer.effect(
    ReloadsRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(records);

      return ReloadsRepository.of({
        findOne: (repo: RepoSlug) =>
          Ref.get(store).pipe(
            Effect.map((stored) =>
              Option.fromUndefinedOr(stored.find((record) => record.repo === repo)),
            ),
          ),
        save: (record: ReloadRoot) =>
          Ref.update(store, (stored) => [
            ...stored.filter((known) => known.repo !== record.repo),
            record,
          ]),
      });
    }),
  );
