import * as Schema from 'effect/Schema';

import { RepoSlug } from '../../../../kernel/repo-slug.id.ts';

// Several clones of one repo are enrolled, and nothing says which one is meant.
export class AmbiguousClone extends Schema.TaggedError<AmbiguousClone, { readonly brand: 'AmbiguousClone' }>()('AmbiguousClone', {
  repo: RepoSlug,
  names: Schema.Array(Schema.String),
}) {
  public override get message() {
    return `${this.repo} is enrolled as ${this.names.join(', ')}; name the one this is with --name`;
  }
}
