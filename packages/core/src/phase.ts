// An item's phase: the high-level state it has reached, recorded through the
// Progress port (services.ts, docs/adr/0019-run-progress-port.md). Core keeps
// no list of phases and gives none a meaning (ADR 0005): it stores one and
// compares it for equality. What it does define is the format, so that a
// phase that works on one backend works on all of them: a branch's commit
// headline or trailer, a hosted service's column, a log line.

import * as Schema from "effect/Schema";

// A phase: lowercase letters and digits in words joined by single hyphens,
// such as `review-asked` or `changes-asked`, at most 64 characters. No
// spaces, newlines, slashes or dots, which a commit trailer, a ref or a URL
// would each read as something else.
export const Phase = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
).pipe(Schema.brand("Phase"));

export type Phase = typeof Phase.Type;

export const isPhase = Schema.is(Phase);

// Who records a transition: the run's id for a run's write, or a name a
// writer outside a run gives itself. A record names it, so a run that resumes
// after a crash knows its own write when it reads it back. Letters, digits
// and `.`, `_`, `:`, `@`, `/`, `+`, `-`, at most 128 characters, starting with
// a letter or digit: a run id, a login, `observer:review.changesRequested`.
export const PhaseWriter = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/),
).pipe(Schema.brand("PhaseWriter"));

export type PhaseWriter = typeof PhaseWriter.Type;

export const isPhaseWriter = Schema.is(PhaseWriter);
