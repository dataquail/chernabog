import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";

import { EnrolledRepoSpecifications } from "../domain/enrolled-repo/enrolled-repo.specification.ts";
import { EnrolledReposRepository } from "../domain/enrolled-repo/enrolled-repos.repository.ts";
import { PersonasInUse } from "./list-personas-in-use.query.ts";

export const listPersonasInUseHandler = Effect.fn("listPersonasInUseHandler")(function* () {
  const repos = yield* (yield* EnrolledReposRepository).findMany(EnrolledRepoSpecifications.all);

  return PersonasInUse.make({
    logins: Arr.dedupe(repos.flatMap((repo) => Object.keys(repo.personas ?? {}))),
  });
});
