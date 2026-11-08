import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { Seeded } from "../domain/scenario/seeded.value-object.ts";

// What a rehearsal's cleanup removed, and what it couldn't, one line each.
export class CleanUp extends Schema.Class<CleanUp, { readonly brand: "CleanUp" }>("CleanUp")({
  removed: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.String),
}) {}

// What the rehearsal's run recorded in its own journal that it made on the
// repo: the issues it created (a plan's sub-issues, a post-merge follow-up),
// and the claim refs it took, each by its item and the run it names. None
// for a rehearsal whose run never started.
export const RunMade = Schema.Struct({
  createdIssues: Schema.Array(Schema.Finite),
  claims: Schema.Array(Schema.Struct({ item: Schema.String, runId: Schema.String })),
});

// Removes what a rehearsal made on `repo`, as `as`: the seeded issues
// (deleted, or closed where the persona may not delete), the seeded pull
// requests and their branches, the pull requests from `branches`, the ones
// the flow made, and those branches, and what `run` says its run made: the
// issues it created, removed as the seeded ones are, and its claim refs,
// each only while it still names the run. Nothing else: on an enrolled repo,
// real work stays. It carries on past what fails, and says what that was.
export const CleanUpScenarioCommand = Command.make("CleanUpScenarioCommand", {
  payload: {
    repo: Schema.String,
    seeded: Seeded,
    branches: Schema.Array(Schema.String),
    run: RunMade,
    // The persona; none for the implicit one.
    as: Schema.Option(Schema.String),
  },
  success: CleanUp,
});

export type CleanUpScenarioPayload = Command.Payload<typeof CleanUpScenarioCommand>;
