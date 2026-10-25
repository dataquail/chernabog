import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunNotFound } from "../domain/run/run.errors.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunView } from "./run.result.ts";

// A run opening or adopting a pull request for its work item, such as an
// issue's run opening the pull request that implements it: the link that
// makes the issue's runs and the pull request's one piece of work.
export const linkPullRequestUseCase = Effect.fn("linkPullRequestUseCase")(function* (
  runId: RunId,
  pullRequest: number,
) {
  const runs = yield* RunsRepository;
  const found = yield* runs.findOne(runId);

  if (Option.isNone(found)) {
    return yield* new RunNotFound({ runId });
  }

  const changed = yield* Effect.fromResult(RunRootOps.linkPullRequest(found.value, pullRequest));
  yield* runs.save(changed);

  return RunView.make({ ...changed });
});
