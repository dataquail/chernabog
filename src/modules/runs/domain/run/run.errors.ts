import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunStatus } from "./run-status.value-object.ts";

// No run has this id.
export class RunNotFound extends Schema.TaggedError<
  RunNotFound,
  { readonly brand: "RunNotFound" }
>()("RunNotFound", { runId: RunId }) {
  public override get message() {
    return `no run ${this.runId}`;
  }
}

// The run has ended, so it takes no step, execution or second ending.
export class RunAlreadyFinished extends Schema.TaggedError<
  RunAlreadyFinished,
  { readonly brand: "RunAlreadyFinished" }
>()("RunAlreadyFinished", { runId: RunId, status: RunStatus }) {
  public override get message() {
    return `run ${this.runId} already finished: ${this.status}`;
  }
}

// The persona already has a run in flight for the item, so it gets no second.
export class RunAlreadyActive extends Schema.TaggedError<
  RunAlreadyActive,
  { readonly brand: "RunAlreadyActive" }
>()("RunAlreadyActive", { runId: RunId }) {
  public override get message() {
    return `run ${this.runId} is already in flight for this item`;
  }
}

// No run's id starts with what a person typed.
export class RunNotNamed extends Schema.TaggedError<
  RunNotNamed,
  { readonly brand: "RunNotNamed" }
>()("RunNotNamed", { asked: Schema.String }) {
  public override get message() {
    return `no run ${this.asked}`;
  }
}

// What a person typed starts several runs' ids.
export class AmbiguousRunPrefix extends Schema.TaggedError<
  AmbiguousRunPrefix,
  { readonly brand: "AmbiguousRunPrefix" }
>()("AmbiguousRunPrefix", { asked: Schema.String, matching: Schema.Array(RunId) }) {
  public override get message() {
    const shown = [
      ...this.matching.slice(0, 5),
      ...Option.toArray(Option.liftPredicate("…", () => this.matching.length > 5)),
    ];

    return `${this.asked} names ${this.matching.length} runs (${shown.join(", ")}); give more of the id`;
  }
}

// No run is in flight for the repo's item, among the ones a person narrowed to.
export class NoRunInFlight extends Schema.TaggedError<
  NoRunInFlight,
  { readonly brand: "NoRunInFlight" }
>()("NoRunInFlight", { repo: Schema.String, itemKey: Schema.String }) {
  public override get message() {
    return `no run in flight for ${this.repo} ${this.itemKey}`;
  }
}

// Several runs are in flight for the repo's item, such as two flows or two
// personas on one pull request.
export class SeveralRunsInFlight extends Schema.TaggedError<
  SeveralRunsInFlight,
  { readonly brand: "SeveralRunsInFlight" }
>()("SeveralRunsInFlight", {
  repo: Schema.String,
  itemKey: Schema.String,
  matching: Schema.Array(RunId),
}) {
  public override get message() {
    return `${this.matching.length} runs are in flight for ${this.repo} ${this.itemKey} (${this.matching.join(", ")}); name one by its id, or narrow with --flow or --as`;
  }
}

// The run has no log, at the path its log would be.
export class RunLogMissing extends Schema.TaggedError<
  RunLogMissing,
  { readonly brand: "RunLogMissing" }
>()("RunLogMissing", { runId: RunId, path: Schema.String }) {
  public override get message() {
    return `no log for ${this.runId} at ${this.path}`;
  }
}

// A flow's trigger, the lookup of an item it didn't report, or its gate
// failed; the message says how.
export class FlowFailed extends Schema.TaggedError<FlowFailed, { readonly brand: "FlowFailed" }>()(
  "FlowFailed",
  { message: Schema.String },
) {}

// The persona can't run its flows here at all, such as a login gh has no
// token for or a reviewer seat it doesn't hold; the message names the fix.
export class PersonaNotReady extends Schema.TaggedError<
  PersonaNotReady,
  { readonly brand: "PersonaNotReady" }
>()("PersonaNotReady", { message: Schema.String }) {}

// Cleaning up what a cancelled run held failed partway; the message says what
// was left.
export class CleanupFailed extends Schema.TaggedError<
  CleanupFailed,
  { readonly brand: "CleanupFailed" }
>()("CleanupFailed", { message: Schema.String }) {}
