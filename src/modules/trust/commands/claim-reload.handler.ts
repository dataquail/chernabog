import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ReloadsRepository } from "../domain/ports/repositories/reloads.repository.ts";
import { ReloadRootOps } from "../domain/reload/reload.root-ops.ts";
import { type ClaimReloadPayload, ReloadClaim } from "./claim-reload.command.ts";

export const claimReloadHandler = Effect.fn("claimReloadHandler")(function* (
  cmd: ClaimReloadPayload,
) {
  const reloads = yield* ReloadsRepository;
  const claimed = ReloadRootOps.claim(yield* reloads.findOne(cmd.repo), cmd.repo, cmd.tree);

  for (const record of Option.toArray(claimed)) {
    yield* reloads.save(record);
  }

  return ReloadClaim.make({ repo: cmd.repo, tree: cmd.tree, first: Option.isSome(claimed) });
});
