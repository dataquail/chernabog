import * as Schema from 'effect/Schema';

// The tree of .chernabog/ on a repo's base branch, or what changed in it,
// couldn't be read: no .chernabog/ there yet, or git failed. The message says
// which and what to do.
export class ConfigTreeUnavailable extends Schema.TaggedError<ConfigTreeUnavailable, { readonly brand: 'ConfigTreeUnavailable' }>()('ConfigTreeUnavailable', {
  message: Schema.String,
}) {}
