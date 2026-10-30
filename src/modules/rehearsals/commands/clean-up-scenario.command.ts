import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { Seeded } from "../domain/scenario/seeded.value-object.ts";

// What a rehearsal's cleanup removed, and what it couldn't, one line each.
export class CleanUp extends Schema.Class<CleanUp, { readonly brand: "CleanUp" }>("CleanUp")({
  removed: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.String),
}) {}

// Removes what a rehearsal made on `repo`, as `as`: the seeded issues
// (deleted, or closed where the persona may not delete), the seeded pull
// requests and their branches, and the pull requests from `branches`, the
// ones the flow made, and those branches. It carries on past what fails, and
// says what that was.
export const CleanUpScenarioCommand = Command.make("CleanUpScenarioCommand", {
  payload: {
    repo: Schema.String,
    seeded: Seeded,
    branches: Schema.Array(Schema.String),
    // The persona; none for the implicit one.
    as: Schema.Option(Schema.String),
  },
  success: CleanUp,
});

export type CleanUpScenarioPayload = Command.Payload<typeof CleanUpScenarioCommand>;
