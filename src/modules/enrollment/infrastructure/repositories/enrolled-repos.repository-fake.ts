import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { type EnrolledRepoRoot } from "../../domain/enrolled-repo/enrolled-repo.root.ts";
import { EnrolledRepoRootOps } from "../../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledReposRepository } from "../../domain/ports/repositories/enrolled-repos.repository.ts";

// Enrolled repos in memory, starting from `repos`. Saving matches an entry by
// slug and name, as the live repository does, and adds one that matches none.
export const EnrolledReposRepositoryFake = (repos: ReadonlyArray<EnrolledRepoRoot>) =>
  Layer.effect(
    EnrolledReposRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(repos);

      const same = (left: EnrolledRepoRoot, right: EnrolledRepoRoot) =>
        left.repo === right.repo &&
        EnrolledRepoRootOps.nameOf(left) === EnrolledRepoRootOps.nameOf(right);

      const save = (repo: EnrolledRepoRoot) =>
        Ref.update(store, (stored) => {
          if (!stored.some((known) => same(known, repo))) {
            return [...stored, repo];
          }

          return stored.map((known) =>
            Option.getOrElse(
              Option.liftPredicate(repo, () => same(known, repo)),
              () => known,
            ),
          );
        });

      const remove = (repo: EnrolledRepoRoot) =>
        Ref.update(store, (stored) => stored.filter((known) => !same(known, repo)));

      return EnrolledReposRepository.of({ findAll: Ref.get(store), save, remove });
    }),
  );
