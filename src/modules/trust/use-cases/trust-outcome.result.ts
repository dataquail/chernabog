import * as Schema from 'effect/Schema';

import { RepoSlug } from '../../../kernel/repo-slug.id.ts';

// What trusting a repo's .chernabog/ found and did: the tree on its base
// branch, the one trusted before, what changed between them (none when it was
// already trusted), and whether it's newly trusted.
export class TrustOutcome extends Schema.Class<TrustOutcome, { readonly brand: 'TrustOutcome' }>('TrustOutcome')({
  repo: RepoSlug,
  tree: Schema.String,
  previous: Schema.Option(Schema.String),
  changes: Schema.Option(Schema.String),
  trusted: Schema.Boolean,
}) {}
