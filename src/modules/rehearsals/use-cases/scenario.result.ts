import * as Schema from "effect/Schema";

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
