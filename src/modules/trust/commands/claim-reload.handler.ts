import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { ReloadsRepository } from "../domain/ports/repositories/reloads.repository.ts";
import { ReloadRootOps } from "../domain/reload/reload.root-ops.ts";
import { ReloadClaim } from "./reload-claim.result.ts";

// Claims a restart of the daemon on a repo's trusted tree, recording it, so
// the same tree never restarts it twice, whatever the repo's status.
export const claimReloadUseCase = Effect.fn("claimReloadUseCase")(function* (
  repo: RepoSlug,
  tree: string,
) {
  const reloads = yield* ReloadsRepository;
  const claimed = ReloadRootOps.claim(yield* reloads.findOne(repo), repo, tree);

  for (const record of Option.toArray(claimed)) {
    yield* reloads.save(record);
  }

  return ReloadClaim.make({ repo, tree, first: Option.isSome(claimed) });
});
