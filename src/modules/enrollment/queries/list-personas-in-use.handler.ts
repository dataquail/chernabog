import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";

import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { PersonasInUse } from "./list-personas-in-use.query.ts";

export const listPersonasInUseHandler = Effect.fn("listPersonasInUseHandler")(function* () {
  const repos = yield* (yield* EnrolledReposRepository).findAll;

  return PersonasInUse.make({
    logins: Arr.dedupe(repos.flatMap((repo) => Object.keys(repo.personas ?? {}))),
  });
});
