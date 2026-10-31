import * as Schema from "effect/Schema";

import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { TeamFlows } from "./team-flows.value-object.ts";

// A checkout of a repo as git and its working copy show it: where it is, the
// repo it's of, and the flows its .chernabog/ has.
export class CheckoutTree extends Schema.Class<CheckoutTree, { readonly brand: "CheckoutTree" }>(
  "CheckoutTree",
)({
  root: Schema.String,
  repo: RepoSlug,
  flows: Schema.Array(Schema.String),
}) {}

// A checkout of a repo, as enrolling it reads it: its tree, and what its team
// says of its flows (TeamFlowsAcl).
export class Checkout extends Schema.Class<Checkout, { readonly brand: "Checkout" }>("Checkout")({
  root: Schema.String,
  repo: RepoSlug,
  flows: Schema.Array(Schema.String),
  team: TeamFlows,
}) {}
