import * as Schema from "effect/Schema";

import { ScenarioFile } from "../../../../kernel/scenario.value-object.ts";

// A scenario a person wrote, read from `path`: everything its file says, and
// where it is, since its scripts' paths start beside it.
export class ScenarioRoot extends Schema.Class<ScenarioRoot, { readonly brand: "ScenarioRoot" }>(
  "ScenarioRoot",
)({
  path: Schema.String,
  dir: Schema.String,
  ...ScenarioFile.fields,
}) {}
