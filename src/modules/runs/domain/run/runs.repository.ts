import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type RunId } from "../../../../../kernel/run-id.id.ts";
import { type RunRoot } from "../../run/run.root.ts";

// Which runs to read: every run still running, oldest first; the latest
// `latest` of all, newest first; or every run of one repo.
export type RunsQuery =
  { readonly running: true } | { readonly latest: number } | { readonly repo: string };

// The runs this machine has started. A store this module writes alone, so
// failing to read or write it is a bug, not a condition: neither fails.
// `save` never rewrites a run that ended with another ending, so a stale copy
// can't bring a finished run back.
export type RunsRepositoryService = {
  readonly findOne: (id: RunId) => Effect.Effect<Option.Option<RunRoot>>;
  readonly findAll: (query: RunsQuery) => Effect.Effect<ReadonlyArray<RunRoot>>;
  readonly save: (run: RunRoot) => Effect.Effect<void>;
};

export class RunsRepository extends Context.Service<RunsRepository, RunsRepositoryService>()(
  "RunsRepository",
) {}
