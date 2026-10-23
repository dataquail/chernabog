import * as Schema from 'effect/Schema';

import { RepoSlug } from '../../../../kernel/repo-slug.id.ts';

// The daemon runs a repo's committed flows and steps unattended, so anyone who
// can change its .chernabog/ can run code on this machine. A trust record is a
// person's approval of one tree of it: the tree hash of .chernabog/ on the
// base branch, as with `direnv allow`. When the tree changes, the repo stops
// until someone reviews the change and trusts it again.
//
// It's kept apart from machine config, which a person edits by hand: only
// approving a tree writes it.
export class TrustRecordRoot extends Schema.Class<TrustRecordRoot, { readonly brand: 'TrustRecordRoot' }>('TrustRecordRoot')({
  repo: RepoSlug,
  tree: Schema.String,
  // When it was trusted, as an ISO timestamp.
  at: Schema.String,
}) {}
