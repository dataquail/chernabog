import * as Schema from "effect/Schema";

// What seeding made on GitHub, by the names the scenario gave it: what a
// rehearsal's run may work on, and what its cleanup removes.
export const SeededIssue = Schema.Struct({ name: Schema.String, number: Schema.Finite });

export const SeededPullRequest = Schema.Struct({
  name: Schema.String,
  number: Schema.Finite,
  branch: Schema.String,
});

export const Seeded = Schema.Struct({
  issues: Schema.Array(SeededIssue),
  // A pull request whose branch was made but which never opened has number 0.
  pullRequests: Schema.Array(SeededPullRequest),
});

export type Seeded = typeof Seeded.Type;

export const NOTHING_SEEDED: Seeded = { issues: [], pullRequests: [] };
