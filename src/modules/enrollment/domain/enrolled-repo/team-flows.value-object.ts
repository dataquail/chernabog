// What the team's .chernabog/config.yaml says about its flows that enrolling
// weighs: which agents each runs, whether the team has it on, who it runs
// as, and who reviews. These are only the defaults enrolling offers; a persona's own choices
// in machine config decide what runs.

import * as Schema from "effect/Schema";

export const TeamFlow = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  agent: Schema.optionalKey(Schema.String),
  agents: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  runners: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type TeamFlow = typeof TeamFlow.Type;

export class TeamFlows extends Schema.Class<TeamFlows, { readonly brand: "TeamFlows" }>(
  "TeamFlows",
)({
  // The repo's agent, which every flow runs unless it says otherwise.
  agent: Schema.Option(Schema.String),
  // Who runs every flow, unless a flow says.
  runners: Schema.Option(Schema.Array(Schema.String)),
  flows: Schema.Record(Schema.String, TeamFlow),
  // The reviewer pool, reviewers: in the team's config.
  reviewers: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

// Why a flow is off when the team, or a person, turned it off.
export const FLOW_TURNED_OFF = "flow turned off";
