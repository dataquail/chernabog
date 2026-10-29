import * as Schema from "effect/Schema";

import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { TeamFlows } from "./team-flows.value-object.ts";

// A checkout of a repo, as enrolling it reads it: where it is, the repo it's
// of, the branch its origin calls HEAD, and the flows its working copy has.
export class Checkout extends Schema.Class<Checkout, { readonly brand: "Checkout" }>("Checkout")({
  root: Schema.String,
  repo: RepoSlug,
  baseBranch: Schema.String,
  flows: Schema.Array(Schema.String),
  team: TeamFlows,
}) {}
