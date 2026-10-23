import * as Option from 'effect/Option';
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

// No enrolled repo answers to the name a person gave.
export class RepoNotEnrolled extends Schema.TaggedError<RepoNotEnrolled, { readonly brand: 'RepoNotEnrolled' }>()('RepoNotEnrolled', {
  asked: Schema.String,
  enrolled: Schema.Array(Schema.String),
}) {
  public override get message() {
    const known = Option.getOrElse(Option.liftPredicate(this.enrolled.join(', '), (names) => names.length > 0), () => 'none');

    return `no enrolled repo named ${this.asked} (enrolled: ${known}); run chernabog enroll in it`;
  }
}
