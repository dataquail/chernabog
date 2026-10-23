import * as Schema from 'effect/Schema';

import { RepoSlug } from '../../../kernel/repo-slug.id.ts';

// The enrolled repos that are paused, by slug.
export class PausedRepos extends Schema.Class<PausedRepos, { readonly brand: 'PausedRepos' }>('PausedRepos')({
  repos: Schema.Array(RepoSlug),
}) {}
