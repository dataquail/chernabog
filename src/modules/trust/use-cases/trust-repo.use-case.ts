import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { ConfigTreeClient } from "../domain/ports/clients/config-tree.client.ts";
import { TrustRecordsRepository } from "../domain/ports/repositories/trust-records.repository.ts";
import { TrustRecordRootOps } from "../domain/trust-record/trust-record.root-ops.ts";
import { TrustOutcome } from "./trust-outcome.result.ts";

// A repo's checkout and the branch its .chernabog/ is trusted from.
export type TrustTarget = {
  readonly repo: RepoSlug;
  readonly path: string;
  readonly baseBranch: string;
};

// A person approves the .chernabog/ on a repo's base branch, so the daemon
// runs its flows: what changed since the tree trusted before comes back for
// them to read. Only a person may do this, so no agent-facing adapter offers it.
export const trustRepoUseCase = Effect.fn("trustRepoUseCase")(function* (target: TrustTarget) {
  const records = yield* TrustRecordsRepository;
  const trees = yield* ConfigTreeClient;
  const tree = yield* trees.treeOf(target.path, target.baseBranch);
  const record = yield* records.findOne(target.repo);
  const previous = Option.map(record, (found) => found.tree);

  const approved = TrustRecordRootOps.approve(
    record,
    target.repo,
    tree,
    DateTime.formatIso(yield* DateTime.now),
  );

  if (Option.isNone(approved)) {
    return TrustOutcome.make({
      repo: target.repo,
      tree,
      previous,
      changes: Option.none(),
      trusted: false,
    });
  }

  const changes = yield* trees.changesSince(target.path, previous, tree);
  yield* records.save(approved.value);

  return TrustOutcome.make({
    repo: target.repo,
    tree,
    previous,
    changes: Option.some(changes),
    trusted: true,
  });
});
