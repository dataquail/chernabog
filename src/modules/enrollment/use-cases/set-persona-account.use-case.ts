import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type Persona } from "../../../kernel/persona.value-object.ts";
import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { MachineOffer } from "../domain/enrolled-repo/machine-offer.value-object.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { EnrolledRepoSummary, type Offered } from "./enrolled-repos.result.ts";

// Picks the account a persona of the repo a person names spends, or one of
// its roles does, or clears the pick so the default applies again. Refused,
// with nothing written, when its accounts would clash.
export const setPersonaAccountUseCase = Effect.fn("setPersonaAccountUseCase")(function* (
  name: string,
  persona: Persona,
  role: Option.Option<string>,
  account: Option.Option<string>,
  offered: Offered,
) {
  const repository = yield* EnrolledReposRepository;
  const repo = yield* Effect.fromResult(EnrolledRepoRootOps.named(yield* repository.findAll, name));

  const picked = yield* Effect.fromResult(
    EnrolledRepoRootOps.checkAccounts(
      EnrolledRepoRootOps.setAccount(repo, persona, role, account),
      persona,
      MachineOffer.make(offered),
    ),
  );

  yield* repository.save(picked);

  return EnrolledRepoSummary.make({
    name: EnrolledRepoRootOps.nameOf(repo),
    repo: repo.repo,
    path: repo.path,
  });
});
