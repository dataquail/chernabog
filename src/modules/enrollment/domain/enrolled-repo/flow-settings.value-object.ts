// How a flow runs: its schedule, concurrency, agent, and the flow's own
// settings. The team's .chernabog/config.yaml sets these per flow, and a
// person's machine config overrides them for the flows each persona runs.

import * as Schema from "effect/Schema";

// A YAML null turns the setting off.
const Nullable = <S extends Schema.Constraint>(schema: S) =>
  Schema.optionalKey(Schema.OptionFromNullOr(schema));

// The old routing keys, which the binary gives the flow as its settings'
// `assignee` and `reviewRequested`, the SDK's Routing's, until core's next
// major (ADR 0005). The engine reads neither.
const Who = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

const whoFor = (key: string) =>
  Nullable(
    Who.annotate({
      description: `Deprecated: set ${key} under flows.<name>.settings, where the flows that route with the SDK's Routing read it. Given to the flow as that setting until then; its own settings win over this.`,
    }),
  );

export const FlowSettings = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  schedule: Schema.optionalKey(Schema.String),
  concurrency: Schema.optionalKey(Schema.Int),
  agent: Schema.optionalKey(
    Schema.String.annotate({
      description: "The adapter this flow's agent steps run with, over the repo's agent.",
    }),
  ),
  agents: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      description:
        "Adapters by role, such as { reviewer: codex }: a step given { role } runs with that role's adapter, falling back to this flow's agent and then the repo's.",
    }),
  ),
  assignee: whoFor("assignee"),
  reviewRequested: whoFor("reviewRequested"),
  settings: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Json).annotate({
      description:
        "The flow's own settings, which its settings schema declares, over the repo's shared settings: key by key.",
    }),
  ),
});

export type FlowSettings = typeof FlowSettings.Type;

const TEAM_ONLY =
  "runners is the team's choice, in .chernabog/config.yaml; to run a flow here anyway, list it under the repo's flows in machine config";

// No value is allowed, so editors flag the key too.
const TeamOnly = Schema.optionalKey(
  Schema.Never.annotate({ description: TEAM_ONLY, message: TEAM_ONLY }),
);

// A flow as a persona runs it. Listing it turns it on; enabled: false turns
// off one it would inherit from the repo's entry.
export const PersonaFlowSettings = Schema.Struct({ ...FlowSettings.fields, runners: TeamOnly });

export type PersonaFlowSettings = typeof PersonaFlowSettings.Type;
