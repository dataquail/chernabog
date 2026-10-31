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
