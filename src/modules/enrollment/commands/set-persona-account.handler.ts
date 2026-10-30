import * as Effect from "effect/Effect";

import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledRepoSummary } from "../domain/enrolled-repo/enrolled-repo-summary.value-object.ts";
import { MachineOffer } from "../domain/enrolled-repo/machine-offer.value-object.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { type SetPersonaAccountPayload } from "./set-persona-account.command.ts";

export const setPersonaAccountHandler = Effect.fn("setPersonaAccountHandler")(function* (
  cmd: SetPersonaAccountPayload,
) {
  const repository = yield* EnrolledReposRepository;

  const repo = yield* Effect.fromResult(
    EnrolledRepoRootOps.named(yield* repository.findAll, cmd.name),
  );

  const picked = yield* Effect.fromResult(
    EnrolledRepoRootOps.checkAccounts(
      EnrolledRepoRootOps.setAccount(repo, cmd.persona, cmd.role, cmd.account),
      cmd.persona,
      MachineOffer.make(cmd.offered),
    ),
  );

  yield* repository.save(picked);

  return EnrolledRepoSummary.make({
    name: EnrolledRepoRootOps.nameOf(repo),
    repo: repo.repo,
    path: repo.path,
  });
});
