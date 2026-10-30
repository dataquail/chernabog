import * as Schema from "effect/Schema";

import { RepoSlug } from "../../../kernel/repo-slug.id.ts";

export { type Offered } from "./enrolled-repos.result.ts";

export const PersonaChoice = Schema.Struct({
  persona: Schema.Option(Schema.String),
  flows: Schema.Array(Schema.String),
  account: Schema.Option(Schema.String),
  accounts: Schema.Array(Schema.String),
});

// A repo as enrolling left it: whether its entry is new, what each persona
// runs and spends.
export class Enrolled extends Schema.Class<Enrolled, { readonly brand: "Enrolled" }>("Enrolled")({
  added: Schema.Boolean,
  name: Schema.String,
  repo: RepoSlug,
  path: Schema.String,
  chosen: Schema.Array(PersonaChoice),
}) {}
