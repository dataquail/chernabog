// The team's .chernabog/config.yaml, as the part of it the recipes module's
// queries read: the repo's agent, runners and reviewers, and what each flow
// says of who runs it and with which agents. Keys it doesn't name are left for
// whoever reads them.

import * as Schema from "effect/Schema";

const Strings = Schema.Array(Schema.String);

export const TeamFlowConfig = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  agent: Schema.optionalKey(Schema.String),
  agents: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  runners: Schema.optionalKey(Strings),
});

export type TeamFlowConfig = typeof TeamFlowConfig.Type;

export const TeamConfigFile = Schema.Struct({
  agent: Schema.optionalKey(Schema.String),
  runners: Schema.optionalKey(Strings),
  reviewers: Schema.optionalKey(Strings),
  flows: Schema.optionalKey(Schema.Record(Schema.String, TeamFlowConfig)),
});

export type TeamConfigFile = typeof TeamConfigFile.Type;
