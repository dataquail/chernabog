import * as Schema from "effect/Schema";

import { type Persona } from "../../../../kernel/persona.value-object.ts";

// What a flow's trigger reports: one piece of work, such as an issue or a pull
// request, by a key a run of the flow is for. As the SDK defines it; a flow
// carries its own data in `data`.
export const WorkItem = Schema.Struct({
  key: Schema.String,
  title: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  data: Schema.Json,
  // The signals it reports, which wake the runs waiting on them.
  signals: Schema.optionalKey(Schema.Array(Schema.String)),
  // Only wakes a run already waiting on it; never starts one.
  wakeOnly: Schema.optionalKey(Schema.Boolean),
  // GitHub logins assigned to it, and asked to review it, which routing reads.
  assignees: Schema.optionalKey(Schema.Array(Schema.String)),
  reviewers: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type WorkItem = typeof WorkItem.Type;

// A flow as one persona runs it on this machine: the repo it's in, by the name
// the daemon schedules it under, the flow's name, and the persona.
export type FlowRef = {
  readonly repo: string;
  readonly flow: string;
  readonly persona: Persona;
};
