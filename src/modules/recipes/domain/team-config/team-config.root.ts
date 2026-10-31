import * as Schema from "effect/Schema";

import { TeamFlowConfig } from "./team-flow-config.value-object.ts";

// The team's config of a checkout: its .chernabog/config.yaml, which the
// recipes module owns as it owns the rest of .chernabog/. This is the part
// of it other modules read: the repo's agent, its runners and reviewers, and
// each flow's. An absent file says nothing.
export class TeamConfigRoot extends Schema.Class<
  TeamConfigRoot,
  { readonly brand: "TeamConfigRoot" }
>("TeamConfigRoot")({
  // The checkout whose .chernabog/config.yaml it is.
  root: Schema.String,
  // The repo's agent, which every flow runs unless it says otherwise.
  agent: Schema.Option(Schema.String),
  // Who runs every flow by default, unless a flow says.
  runners: Schema.Option(Schema.Array(Schema.String)),
  // The reviewer pool.
  reviewers: Schema.Option(Schema.Array(Schema.String)),
  flows: Schema.Record(Schema.String, TeamFlowConfig),
}) {}
