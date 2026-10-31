import * as Schema from "effect/Schema";

// What the team's .chernabog/config.yaml says about a flow that decides who
// runs it and with which agents: whether the team has it on, its agent, its
// agents by role, and its runners.
export const TeamFlowConfig = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  agent: Schema.optionalKey(Schema.String),
  agents: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  runners: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type TeamFlowConfig = typeof TeamFlowConfig.Type;

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
