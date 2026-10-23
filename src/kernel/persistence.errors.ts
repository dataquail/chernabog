import * as Schema from 'effect/Schema';

// A store couldn't be read or written: a file that doesn't parse, or one the
// disk refused. The message names the file and what was wrong with it.
export class PersistenceFailed extends Schema.TaggedError<PersistenceFailed, { readonly brand: 'PersistenceFailed' }>()('PersistenceFailed', {
  message: Schema.String,
}) {}
