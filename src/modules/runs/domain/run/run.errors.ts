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
