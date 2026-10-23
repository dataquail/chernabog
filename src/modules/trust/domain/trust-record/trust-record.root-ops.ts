import * as Option from 'effect/Option';

import { type RepoSlug } from '../../../../kernel/repo-slug.id.ts';
import { TrustRecordRoot } from './trust-record.root.ts';

// Whether a repo's trust record approves this tree of its .chernabog/.
const trusts = (record: Option.Option<TrustRecordRoot>, tree: string) => Option.exists(record, (found) => found.tree === tree);

// A person approving a tree of a repo's .chernabog/, at `at`: the record that
// trusts it, none when it's already the trusted one.
const approve = (record: Option.Option<TrustRecordRoot>, repo: RepoSlug, tree: string, at: string) =>
  Option.map(
    Option.liftPredicate(tree, () => !trusts(record, tree)),
    (approved) => TrustRecordRoot.make({ repo, tree: approved, at }),
  );

export const TrustRecordRootOps = { trusts, approve } as const;
