import * as Schema from "effect/Schema";

// A store couldn't be read or written: a file that doesn't parse, or one the
// disk refused. The message names the file and what was wrong with it.
// `busy` when another process held the file's lock for longer than a write
// waits (src/platform/file-lock.ts): nothing is wrong with it, and trying
// again shortly will do.
export class PersistenceFailed extends Schema.TaggedError<
  PersistenceFailed,
  { readonly brand: "PersistenceFailed" }
>()("PersistenceFailed", {
  message: Schema.String,
  busy: Schema.optionalKey(Schema.Boolean),
}) {}
