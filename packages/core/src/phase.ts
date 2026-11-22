// An item's phase: the high-level state it has reached, recorded through the
// Progress port (services.ts, docs/adr/0019-run-progress-port.md). Core keeps
// no list of phases and gives none a meaning (ADR 0005): it stores one and
// compares it for equality. What it does define is the format, so that a
// phase that works on one backend works on all of them: a branch's commit
// headline or trailer, a hosted service's column, a log line.

import * as Schema from "effect/Schema";

import { printJson } from "./json.ts";

// A phase: lowercase letters and digits in words joined by single hyphens,
// such as `review-asked` or `changes-asked`, at most 64 characters. No
// spaces, newlines, slashes or dots, which a commit trailer, a ref or a URL
// would each read as something else.
// Stryker disable StringLiteral: a brand's name types the value; at run time it only names it in a parse error
export const Phase = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
).pipe(Schema.brand("Phase"));
// Stryker restore StringLiteral

export type Phase = typeof Phase.Type;

export const isPhase = Schema.is(Phase);

// Who records a transition: the run's id for a run's write, or a name a
// writer outside a run gives itself. A record names it, so a run that resumes
// after a crash knows its own write when it reads it back. Letters, digits
// and `.`, `_`, `:`, `@`, `/`, `+`, `-`, at most 128 characters, starting with
// a letter or digit: a run id, a login, `observer:review.changesRequested`.
// Stryker disable StringLiteral: a brand's name types the value; at run time it only names it in a parse error
export const PhaseWriter = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/),
).pipe(Schema.brand("PhaseWriter"));
// Stryker restore StringLiteral

export type PhaseWriter = typeof PhaseWriter.Type;

export const isPhaseWriter = Schema.is(PhaseWriter);

// The most a record's data may take, as JSON text in UTF-8.
export const PHASE_DATA_MAX_BYTES = 4096;

const fitsARecord = (data: { readonly [key: string]: Schema.Json }) => {
  const bytes = new TextEncoder().encode(printJson(data)).length;

  return (
    bytes <= PHASE_DATA_MAX_BYTES ||
    `a record's data is ${bytes} bytes as JSON, over the ${PHASE_DATA_MAX_BYTES} it may take`
  );
};

// What a record carries for the run that picks the item up next, such as the
// pull request a run adopted or a plan's round (ADR 0021, decision 4): a JSON
// object of at most PHASE_DATA_MAX_BYTES. Core gives it no meaning and never
// compares it: an advance is a compare-and-set on the phase alone.
export const PhaseData = Schema.Record(Schema.String, Schema.Json).pipe(
  Schema.check(Schema.makeFilter(fitsARecord)),
  // Stryker disable next-line StringLiteral: a brand's name types the value; at run time it only names it in a parse error
  Schema.brand("PhaseData"),
);

export type PhaseData = typeof PhaseData.Type;

export const isPhaseData = Schema.is(PhaseData);
