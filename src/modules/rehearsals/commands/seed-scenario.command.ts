import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { SeedingFailed } from "../domain/scenario/scenario.errors.ts";
import { ScenarioRoot } from "../domain/scenario/scenario.root.ts";
import { Seeded } from "../domain/scenario/seeded.value-object.ts";

// Seeds the scenario's given: state on its repo, as `as`: its issues, then
// its pull requests, each from a new branch with its commits, on the repo's
// default branch unless it names another. A seeding that fails partway says
// what it made before, for cleanup to remove.
export const SeedScenarioCommand = Command.make("SeedScenarioCommand", {
  payload: {
    scenario: ScenarioRoot,
    // The persona; none for the implicit one.
    as: Schema.Option(Schema.String),
  },
  success: Seeded,
  failure: SeedingFailed,
});

export type SeedScenarioPayload = Command.Payload<typeof SeedScenarioCommand>;
