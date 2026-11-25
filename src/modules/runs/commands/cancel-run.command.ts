import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { CancelledRun, CancelTarget, EndAs } from "../domain/run/cancelled-run.value-object.ts";
import {
  AmbiguousRunPrefix,
  NoRunInFlight,
  RunAlreadyFinished,
  RunNotFound,
  RunNotNamed,
  RunNotParked,
  SeveralRunsInFlight,
} from "../domain/run/run.errors.ts";

// Ends a run in flight for good: records it cancelled, by whom and when (or
// needing a person, and why, for a run this binary can't resume,
// superseded, and why, for a run whose work item went, or lost, to the run
// that took its item over, which keeps what it left),
// before its workflow could record anything else; forgets its waits;
// interrupts its workflow, which the engine keeps across a restart; and then
// cleans up what it held: its worktrees, its claim ref, its claim on its
// issue, and, if asked, its agent sessions; and only then says it ended
// (RunFinished), for its markers' release. What cleaning up can't do is left
// for a person, and said; it never undoes the cancel. Pull requests are never
// touched. A run that has already ended only lets go of the markers and claim
// ref it still holds.
export const CancelRunCommand = Command.make("CancelRunCommand", {
  payload: {
    target: CancelTarget,
    // Who cancels it, for its summary.
    by: Schema.String,
    // Whether to close the agent sessions it left open, by their launcher's
    // handle; otherwise they're left for the person.
    closeSessions: Schema.Boolean,
    // With closeSessions, whether to leave open the sessions a person works
    // in: for a run that a stopped process left, whose sessions nobody is
    // watching but a person's (ADR 23, #665). A person's own cancel closes
    // what it is asked to.
    sparePersonSessions: Schema.optionalKey(Schema.Boolean),
    // How it ends instead of cancelled, and why; none for a cancel.
    endAs: Schema.Option(EndAs),
  },
  success: CancelledRun,
  failure: Schema.Union([
    RunNotFound,
    RunAlreadyFinished,
    RunNotNamed,
    AmbiguousRunPrefix,
    NoRunInFlight,
    SeveralRunsInFlight,
    RunNotParked,
  ]),
});

export type CancelRunPayload = Command.Payload<typeof CancelRunCommand>;
