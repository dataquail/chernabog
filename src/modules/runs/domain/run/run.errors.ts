import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunStatus } from "./run.root.ts";

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

// The run has no log, at the path its log would be.
export class RunLogMissing extends Schema.TaggedError<
  RunLogMissing,
  { readonly brand: "RunLogMissing" }
>()("RunLogMissing", { runId: RunId, path: Schema.String }) {
  public override get message() {
    return `no log for ${this.runId} at ${this.path}`;
  }
}
