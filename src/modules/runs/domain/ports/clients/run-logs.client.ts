import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type RunId } from "../../../../../kernel/run-id.id.ts";

// Each run's log: what its steps and agent sessions said, as the engine wrote
// it. The engine appends to a run's log as it goes, so each read is afresh.
export type RunLogsClientService = {
  // The runs that have a log, or had one a prune removed.
  readonly ids: Effect.Effect<ReadonlyArray<RunId>>;
  // Where a run's log is, whether or not it's been written yet.
  readonly pathOf: (runId: RunId) => Effect.Effect<string>;
  // A run's log from `offset` characters in; none while it has no log.
  readonly readFrom: (runId: RunId, offset: number) => Effect.Effect<Option.Option<string>>;
  // When a run's log was last written, in epoch millis; none while it has no log.
  readonly modifiedAt: (runId: RunId) => Effect.Effect<Option.Option<number>>;
  // Removes a run's log past its retention, leaving a note that it did.
  readonly prune: (runId: RunId) => Effect.Effect<void>;
  // Whether a prune removed the run's log.
  readonly pruned: (runId: RunId) => Effect.Effect<boolean>;
};

export class RunLogsClient extends Context.Service<RunLogsClient, RunLogsClientService>()(
  "RunLogsClient",
) {}
