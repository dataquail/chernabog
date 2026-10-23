// How a flow runs: its schedule, concurrency, agent, and whose work items it
// starts. The team's .chernabog/config.yaml sets these per flow, and a person's
// machine config overrides them for the flows each persona runs.

import * as Schema from 'effect/Schema';

// A YAML null turns the setting off.
const Nullable = <S extends Schema.Constraint>(schema: S) => Schema.optionalKey(Schema.OptionFromNullOr(schema));

// Who a work item must be for, as in GitHub's assignee: and review-requested:
// qualifiers: @me (this machine's GitHub login), a login, or none.
const Who = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

const whoFor = (qualifier: string) =>
  Nullable(
    Who.annotate({
      description: `Start only work items whose ${qualifier} include one of these: @me for this machine's GitHub login, a login, or none for nobody. null clears the team's.`,
    }),
  );

export const FlowSettings = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  schedule: Schema.optionalKey(Schema.String),
  concurrency: Schema.optionalKey(Schema.Int),
  agent: Schema.optionalKey(Schema.String.annotate({ description: "The adapter this flow's agent steps run with, over the repo's agent." })),
  agents: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      description: "Adapters by role, such as { reviewer: codex }: a step given { role } runs with that role's adapter, falling back to this flow's agent and then the repo's.",
    }),
  ),
  assignee: whoFor('assignees'),
  reviewRequested: whoFor('requested reviewers'),
});

export type FlowSettings = typeof FlowSettings.Type;

const TEAM_ONLY = 'runners is the team\'s choice, in .chernabog/config.yaml; to run a flow here anyway, list it under the repo\'s flows in machine config';

// No value is allowed, so editors flag the key too.
const TeamOnly = Schema.optionalKey(Schema.Never.annotate({ description: TEAM_ONLY, message: TEAM_ONLY }));

// A flow as a persona runs it. Listing it turns it on; enabled: false turns
// off one it would inherit from the repo's entry.
export const PersonaFlowSettings = Schema.Struct({ ...FlowSettings.fields, runners: TeamOnly });

export type PersonaFlowSettings = typeof PersonaFlowSettings.Type;
