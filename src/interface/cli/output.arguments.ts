import * as Flag from "effect/cli/Flag";

// Whether a command prints its result as JSON, for a script, rather than as
// lines for a person.
export const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print the result as JSON"),
  Flag.withDefault(false),
);
