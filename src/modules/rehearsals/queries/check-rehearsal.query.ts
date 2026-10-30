import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { Ending } from "../../../kernel/scenario.value-object.ts";
import { StandIns } from "../../../kernel/stand-in.value-object.ts";
import { ScratchRepoFailed } from "../domain/scenario/scenario.errors.ts";
import { ScenarioRoot } from "../domain/scenario/scenario.root.ts";
import { Seeded } from "../domain/scenario/seeded.value-object.ts";

// A pull request the rehearsal touched, and who it still asks to review it.
export const ReviewRequest = Schema.Struct({
  pullRequest: Schema.Finite,
  logins: Schema.Array(Schema.String),
});

// How a rehearsal's run turned out against its scenario: the labels its item
// carries, what the scenario expected that didn't happen, and the review
// requests left on the pull requests seeded or opened, and the stand-ins it
// never used.
export class RehearsalCheck extends Schema.Class<
  RehearsalCheck,
  { readonly brand: "RehearsalCheck" }
>("RehearsalCheck")({
  labels: Schema.Array(Schema.String),
  missed: Schema.Array(Schema.String),
  reviewRequests: Schema.Array(ReviewRequest),
  // Stand-ins no step asked for.
  unused: Schema.Array(Schema.String),
}) {}

// Reads back what a rehearsal's run left on GitHub, as `as`, and compares it
// with the scenario's expect:. `item` is the key of the work item it ran on;
// `branches` are the ones the flow made for it, such as auto/issue-12, whose
// pull requests are checked for review requests beside the seeded ones. A
// stand-in no step used is reported: a replayed step the flow no longer has.
export const CheckRehearsalQuery = Query.make("CheckRehearsalQuery", {
  payload: {
    scenario: ScenarioRoot,
    seeded: Seeded,
    item: Schema.String,
    ending: Ending,
    summary: Schema.String,
    branches: Schema.Array(Schema.String),
    // The stand-ins it ran with, and the steps that asked the agent.
    standIns: StandIns,
    asked: Schema.Array(Schema.String),
    // The persona; none for the implicit one.
    as: Schema.Option(Schema.String),
  },
  success: RehearsalCheck,
  failure: ScratchRepoFailed,
});

export type CheckRehearsalPayload = Query.Payload<typeof CheckRehearsalQuery>;
