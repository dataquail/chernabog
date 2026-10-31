import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ReloadRootOps } from "../domain/reload/reload.root-ops.ts";
import { ReloadSpecifications } from "../domain/reload/reload.specification.ts";
import { ReloadsRepository } from "../domain/reload/reloads.repository.ts";
import { type ClaimReloadPayload, ReloadClaim } from "./claim-reload.command.ts";

export const claimReloadHandler = Effect.fn("claimReloadHandler")(function* (
  cmd: ClaimReloadPayload,
) {
  const reloads = yield* ReloadsRepository;

  const claimed = ReloadRootOps.claim(
    yield* reloads.findOne(ReloadSpecifications.forRepo(cmd.repo)),
    cmd.repo,
    cmd.tree,
  );

  for (const record of Option.toArray(claimed)) {
    yield* reloads.upsertOne(record);
  }

  return ReloadClaim.make({ repo: cmd.repo, tree: cmd.tree, first: Option.isSome(claimed) });
});
