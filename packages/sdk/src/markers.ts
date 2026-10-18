// Hidden markers in pull request comments, so a later run can find what an
// earlier one left: who wrote the pull request, and what each review saw.

import * as Arr from 'effect/Array';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

import type { Json } from './json.ts';

export const SessionMarker = Schema.Struct({ adapter: Schema.String, sessionId: Schema.String, issue: Schema.Finite, branch: Schema.String });

export type SessionMarker = typeof SessionMarker.Type;

export const ReviewMarker = Schema.Struct({ sha: Schema.String, round: Schema.Finite, verdict: Schema.Literals(['approve', 'request-changes']) });

export type ReviewMarker = typeof ReviewMarker.Type;

const marker = <A>(name: string, schema: Schema.Codec<A, Json>) => {
  const pattern = new RegExp(`<!-- chernabog-${name} (\\{.*?\\}) -->`);
  const codec = Schema.fromJsonString(schema);

  return {
    write: (value: A) => `<!-- chernabog-${name} ${Schema.encodeSync(codec)(value)} -->`,
    read: (body: string): Option.Option<A> =>
      Option.fromNullishOr(body.match(pattern)).pipe(Option.flatMap((match) => Schema.decodeOption(codec)(match[1]))),
  };
};

export const ClaimMarker = Schema.Struct({ runId: Schema.String, claimedAt: Schema.String, branch: Schema.String });

export type ClaimMarker = typeof ClaimMarker.Type;

export const claimMarker = marker('claim', ClaimMarker);
export const sessionMarker = marker('session', SessionMarker);
export const reviewMarker = marker('review', ReviewMarker);

// The newest marker among comment bodies, oldest first.
export const latestMarker = <A>(read: (body: string) => Option.Option<A>, bodies: ReadonlyArray<string>): Option.Option<A> =>
  Arr.last(bodies.flatMap((body) => Option.toArray(read(body))));
