import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { AdoptedRuns } from "../domain/run/run-view.value-object.ts";

// Once a repo has named personas, its runs from before them become the
// persona's it runs as first, so they keep resuming and holding its slots.
export const AdoptImplicitRunsCommand = Command.make("AdoptImplicitRunsCommand", {
  payload: { repo: Schema.String, login: Schema.String },
  success: AdoptedRuns,
});

export type AdoptImplicitRunsPayload = Command.Payload<typeof AdoptImplicitRunsCommand>;
