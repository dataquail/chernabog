import * as Schema from "effect/Schema";

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
