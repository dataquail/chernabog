import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { PersistenceFailed } from "../../../../kernel/persistence.errors.ts";
import { type EnrolledRepoRoot } from "../../domain/enrolled-repo/enrolled-repo.root.ts";
import { EnrolledRepoRootOps } from "../../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledReposRepository } from "../../domain/ports/repositories/enrolled-repos.repository.ts";

// Enrolled repos in memory, starting from `repos`. Saving matches an entry by
// slug and name, as the live repository does, and refuses one not enrolled.
export const EnrolledReposRepositoryFake = (repos: ReadonlyArray<EnrolledRepoRoot>) =>
  Layer.effect(
    EnrolledReposRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(repos);

      const same = (left: EnrolledRepoRoot, right: EnrolledRepoRoot) =>
        left.repo === right.repo &&
        EnrolledRepoRootOps.nameOf(left) === EnrolledRepoRootOps.nameOf(right);

      const save = (repo: EnrolledRepoRoot) =>
        Effect.gen(function* () {
          const stored = yield* Ref.get(store);

          if (!stored.some((known) => same(known, repo))) {
            return yield* new PersistenceFailed({
              message: `${repo.repo} isn't enrolled; run chernabog enroll in it`,
            });
          }

          yield* Ref.set(
            store,
            stored.map((known) =>
              Option.getOrElse(
                Option.liftPredicate(repo, () => same(known, repo)),
                () => known,
              ),
            ),
          );
        });

      return EnrolledReposRepository.of({ findAll: Ref.get(store), save });
    }),
  );
