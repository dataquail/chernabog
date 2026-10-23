import * as Schema from "effect/Schema";

// Something chernabog was given to work from is wrong: a config file that
// doesn't decode, a repo or flow that isn't there, a choice that can't be
// made. The message says what, and what to do.
export class ConfigError extends Schema.TaggedError<
  ConfigError,
  { readonly brand: "ConfigError" }
>()("ConfigError", {
  message: Schema.String,
}) {}
