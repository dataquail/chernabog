// The part of .chernabog/config.yaml a TeamConfigRoot holds, as stored. Keys
// it doesn't name are left for whoever reads them.

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { TeamConfigRoot } from "../../domain/team-config/team-config.root.ts";
import { TeamFlowConfig } from "../../domain/team-config/team-flow-config.value-object.ts";

const Strings = Schema.Array(Schema.String);

export const TeamConfigFile = Schema.Struct({
  agent: Schema.optionalKey(Schema.String),
  runners: Schema.optionalKey(Strings),
  reviewers: Schema.optionalKey(Strings),
  flows: Schema.optionalKey(Schema.Record(Schema.String, TeamFlowConfig)),
});

export type TeamConfigFile = typeof TeamConfigFile.Type;

export const toRoot = (root: string, file: TeamConfigFile) =>
  TeamConfigRoot.make({
    root,
    agent: Option.fromUndefinedOr(file.agent),
    runners: Option.fromUndefinedOr(file.runners),
    reviewers: Option.fromUndefinedOr(file.reviewers),
    flows: file.flows ?? {},
  });
