import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { TeamFlowConfig } from "../storage/team-config.schema.ts";

// What the team's .chernabog/config.yaml says about who runs its flows and
// with which agents: the repo's agent, runners and reviewers, and each flow's.
export class TeamConfig extends Schema.Class<TeamConfig, { readonly brand: "TeamConfig" }>(
  "TeamConfig",
)({
  agent: Schema.Option(Schema.String),
  runners: Schema.Option(Schema.Array(Schema.String)),
  reviewers: Schema.Option(Schema.Array(Schema.String)),
  flows: Schema.Record(Schema.String, TeamFlowConfig),
}) {}

// The team's config of the checkout at `root`. Published to the enrollment
// module (recipes.exports.ts), whose enrolling offers the team's defaults.
export const ReadTeamConfigQuery = Query.make("ReadTeamConfigQuery", {
  payload: { root: Schema.String },
  success: TeamConfig,
  failure: PersistenceFailed,
});

export type ReadTeamConfigPayload = Query.Payload<typeof ReadTeamConfigQuery>;
