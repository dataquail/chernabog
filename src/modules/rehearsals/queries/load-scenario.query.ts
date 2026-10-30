import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RehearsesEnrolledRepo, ScenarioInvalid } from "../domain/scenario/scenario.errors.ts";
import { ScenarioRoot } from "../domain/scenario/scenario.root.ts";

// A scenario ready to rehearse: the flow it rehearses, and whether its repo
// is one this machine is enrolled in, which the rehearsal pauses meanwhile.
export class LoadedScenario extends Schema.Class<
  LoadedScenario,
  { readonly brand: "LoadedScenario" }
>("LoadedScenario")({
  scenario: ScenarioRoot,
  flow: Schema.String,
  enrolled: Schema.Boolean,
}) {}

// Reads the scenario a person names for a flow, and refuses one that would
// seed a repo this machine is enrolled in (`enrolled`, by owner/name) unless
// the scenario or the person (`allowEnrolled`) says that's meant.
export const LoadScenarioQuery = Query.make("LoadScenarioQuery", {
  payload: {
    path: Schema.String,
    flow: Schema.String,
    enrolled: Schema.Array(Schema.String),
    allowEnrolled: Schema.Boolean,
  },
  success: LoadedScenario,
  failure: Schema.Union([ScenarioInvalid, RehearsesEnrolledRepo]),
});

export type LoadScenarioPayload = Query.Payload<typeof LoadScenarioQuery>;
