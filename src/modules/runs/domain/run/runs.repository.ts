import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type Specification } from "../../../../kernel/specification.ts";
import { type RunRoot } from "./run.root.ts";

// The runs this machine has started, read by a spec (RunSpecifications);
// `findMany` reads them oldest first. A store this module writes alone, so
// failing to read or write it is a bug, not a condition: neither fails.
// `upsertOne` never rewrites a run that ended with another ending, so a stale
// copy can't bring a finished run back.
export type RunsRepositoryService = {
  readonly findOne: (spec: Specification<RunRoot>) => Effect.Effect<Option.Option<RunRoot>>;
  readonly findMany: (spec: Specification<RunRoot>) => Effect.Effect<ReadonlyArray<RunRoot>>;
  readonly upsertOne: (run: RunRoot) => Effect.Effect<void>;
};

export class RunsRepository extends Context.Service<RunsRepository, RunsRepositoryService>()(
  "RunsRepository",
) {}
