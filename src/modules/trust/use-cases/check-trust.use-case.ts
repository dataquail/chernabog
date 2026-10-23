import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { ConfigTreeClient } from "../domain/ports/clients/config-tree.client.ts";
import { TrustRecordsRepository } from "../domain/ports/repositories/trust-records.repository.ts";
import { TrustRecordRootOps } from "../domain/trust-record/trust-record.root-ops.ts";
import { TrustCheck } from "./trust-check.result.ts";

// Whether a repo's .chernabog/ is trusted, as git has it now, without asking
// origin: for showing it, where the daemon, which decides it, isn't running.
export const checkTrustUseCase = Effect.fn("checkTrustUseCase")(function* (target: {
  readonly repo: RepoSlug;
  readonly path: string;
  readonly baseBranch: string;
}) {
  const tree = yield* Effect.option(
    (yield* ConfigTreeClient).localTreeOf(target.path, target.baseBranch),
  );

  const record = yield* (yield* TrustRecordsRepository).findOne(target.repo);

  return TrustCheck.make({
    repo: target.repo,
    tree,
    trusted: Option.exists(tree, (found) => TrustRecordRootOps.trusts(record, found)),
  });
});
