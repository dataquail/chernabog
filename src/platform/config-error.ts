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

// A repo's .chernabog/ this binary can't run: its flows were written against
// an SDK outside the range it supports, or import something it doesn't have.
// The repo is refused, not loaded, and the message says which side to upgrade.
export class IncompatibleConfig extends Schema.TaggedError<
  IncompatibleConfig,
  { readonly brand: "IncompatibleConfig" }
>()("IncompatibleConfig", {
  message: Schema.String,
}) {}
