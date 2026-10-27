import * as Schema from "effect/Schema";

import { RunView } from "./run.result.ts";

// How a person names the run to cancel: by its id, or enough of it to tell it
// from the rest, or by the repo's item it's in flight for, narrowed by flow
// and persona when several are.
export const CancelTarget = Schema.TaggedUnion({
  ById: { asked: Schema.String },
  ByItem: {
    repo: Schema.String,
    itemKey: Schema.String,
    flow: Schema.OptionFromNullOr(Schema.String),
    persona: Schema.OptionFromNullOr(Schema.String),
  },
});

export type CancelTarget = typeof CancelTarget.Type;

const OpenSessionView = Schema.Struct({
  sessionId: Schema.String,
  launcher: Schema.String,
  handle: Schema.String,
});

// A cancelled run and what cancelling it cleaned up: the worktrees removed,
// the claim refs deleted, the claim released on its issue, the sessions
// closed, and what it left for a person, each with why. For a run that had
// already ended, only the claim refs it left behind.
export class CancelledRun extends Schema.Class<CancelledRun, { readonly brand: "CancelledRun" }>(
  "CancelledRun",
)({
  run: RunView,
  // The run had ended before, as its flow left it: cancel only deleted the
  // claim refs it still held, and the run keeps its ending.
  alreadyEnded: Schema.Boolean,
  // Whether its workflow had stopped by the time cancel returned; false for
  // one still stopping, or a flow this process didn't load, which the engine
  // stops when it next runs it.
  stopped: Schema.Boolean,
  wakesCleared: Schema.Finite,
  removedWorktrees: Schema.Array(Schema.String),
  // The claim refs it deleted, such as `refs/chernabog/claims/issue-3`.
  releasedClaims: Schema.Array(Schema.String),
  // The issue whose claim it released, and its branch, if deleted.
  released: Schema.OptionFromNullOr(
    Schema.Struct({ issue: Schema.Finite, deletedBranch: Schema.OptionFromNullOr(Schema.String) }),
  ),
  closedSessions: Schema.Array(OpenSessionView),
  openSessions: Schema.Array(OpenSessionView),
  // What it left, each a sentence saying what and why.
  leftForPerson: Schema.Array(Schema.String),
}) {}
