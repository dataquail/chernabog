// Hidden markers in pull request comments, so a later run can find what an
// earlier one left: who wrote the pull request, and what each review saw.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { Json } from "./json.ts";

// The session that wrote a pull request. withPerson: a person worked in it
// with the agent, on the hybrid path, so answering a review reopens it in
// front of them.
export const SessionMarker = Schema.Struct({
  adapter: Schema.String,
  sessionId: Schema.String,
  issue: Schema.Finite,
  branch: Schema.String,
  withPerson: Schema.optionalKey(Schema.Boolean),
});

export type SessionMarker = typeof SessionMarker.Type;

// What a review saw and said, and who gave it in which session, so a
// re-review resumes it. reviewer, sessionId and adapter are optional only so
// that markers posted before they existed still read back.
export const ReviewMarker = Schema.Struct({
  sha: Schema.String,
  round: Schema.Finite,
  verdict: Schema.Literals(["approve", "request-changes"]),
  reviewer: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(Schema.String),
  adapter: Schema.optionalKey(Schema.String),
});

export type ReviewMarker = typeof ReviewMarker.Type;

const marker = <A>(name: string, schema: Schema.Codec<A, Json>) => {
  const pattern = new RegExp(`<!-- chernabog-${name} (\\{.*?\\}) -->`);
  const codec = Schema.fromJsonString(schema);

  return {
    write: (value: A) => `<!-- chernabog-${name} ${Schema.encodeSync(codec)(value)} -->`,
    read: (body: string): Option.Option<A> =>
      Option.fromNullishOr(body.match(pattern)).pipe(
        Option.flatMap((match) => Schema.decodeOption(codec)(match[1])),
      ),
  };
};

// withPerson: claimed by a person's `chernabog start`, which another start of
// the issue may take over. ref: the claim is a claim ref (Claims), which a
// run of this version always writes; a marker without it is from a run that
// held the issue by its branch alone. base: the branch the run builds on, so
// a run that resumes keeps it; a marker without it is on the repo's base branch.
export const ClaimMarker = Schema.Struct({
  runId: Schema.String,
  claimedAt: Schema.String,
  branch: Schema.String,
  base: Schema.optionalKey(Schema.String),
  withPerson: Schema.optionalKey(Schema.Boolean),
  ref: Schema.optionalKey(Schema.Boolean),
});

export type ClaimMarker = typeof ClaimMarker.Type;

// A run that owns a pull request, or let it go: the standalone review and fix
// flows leave a pull request alone while a run of another flow owns it. ref:
// the run holds the pull request's claim ref (Claims), which decides; a marker
// without it is from a run that owned it by comment alone.
export const OwnerMarker = Schema.Struct({
  flow: Schema.String,
  runId: Schema.String,
  released: Schema.Boolean,
  ref: Schema.optionalKey(Schema.Boolean),
});

export type OwnerMarker = typeof OwnerMarker.Type;

// A plan proposed on its spec issue, by round, so the run finds the comments
// a person left on it since.
export const PlanMarker = Schema.Struct({ round: Schema.Finite });

export type PlanMarker = typeof PlanMarker.Type;

// An issue a plan made: its spec and its task's key, so a run that resumes
// finds the issues it made rather than making them twice.
export const PlanNodeMarker = Schema.Struct({ spec: Schema.Finite, key: Schema.String });

export type PlanNodeMarker = typeof PlanNodeMarker.Type;

export const claimMarker = marker("claim", ClaimMarker);
export const sessionMarker = marker("session", SessionMarker);
export const reviewMarker = marker("review", ReviewMarker);
export const ownerMarker = marker("owner", OwnerMarker);
export const planMarker = marker("plan", PlanMarker);
export const planNodeMarker = marker("plan-node", PlanNodeMarker);

// Whether a body carries any of chernabog's markers: a comment chernabog wrote.
export const hasMarker = (body: string) => /<!-- chernabog-[\w-]+ \{/.test(body);

// The newest marker among comment bodies, oldest first.
export const latestMarker = <A>(
  read: (body: string) => Option.Option<A>,
  bodies: ReadonlyArray<string>,
): Option.Option<A> => Arr.last(bodies.flatMap((body) => Option.toArray(read(body))));
