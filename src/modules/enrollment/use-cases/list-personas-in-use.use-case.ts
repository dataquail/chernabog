import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";

import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { PersonasInUse } from "./personas-in-use.result.ts";

// The logins enrolled repos run as, each once: setting up the machine can't
// drop one without stranding a repo.
export const listPersonasInUseUseCase = Effect.fn("listPersonasInUseUseCase")(function* () {
  const repos = yield* (yield* EnrolledReposRepository).findAll;

  return PersonasInUse.make({
    logins: Arr.dedupe(repos.flatMap((repo) => Object.keys(repo.personas ?? {}))),
  });
});
