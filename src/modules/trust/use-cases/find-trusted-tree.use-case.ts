import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';

import { type RepoSlug } from '../../../kernel/repo-slug.id.ts';
import { TrustRecordsRepository } from '../domain/ports/repositories/trust-records.repository.ts';
import { TrustedTree } from './trusted-tree.result.ts';

// The tree of a repo's .chernabog/ a person trusts, which the daemon runs flows
// from only while it's the one on the base branch.
export const findTrustedTreeUseCase = Effect.fn('findTrustedTreeUseCase')(function* (repo: RepoSlug) {
  const record = yield* (yield* TrustRecordsRepository).findOne(repo);

  return TrustedTree.make({ repo, tree: Option.map(record, (found) => found.tree) });
});
