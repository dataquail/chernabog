import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { type RunId } from "../../../kernel/run-id.id.ts";
import { FlowsClient } from "../domain/ports/clients/flows.client.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { type ItemValidity } from "../domain/run/work-item.value-object.ts";
import { RunValidity } from "./check-run-validity.result.ts";

const unchecked = RunValidity.cases.Unchecked.make({});

const toValidity = (validity: ItemValidity): RunValidity => {
  if (validity.valid) {
    return RunValidity.cases.Valid.make({});
  }

  return RunValidity.cases.Gone.make({ reason: validity.reason });
};

// Asks a run's flow whether its work item is still valid, as the run's
// persona, about the run, the item it kept and the pull request it opened.
// A run that has ended, kept no item or has no execution yet, or whose flow
// has no stillValid, isn't checked; a check that fails is CheckFailed, never
// Gone. Ending a gone run is the caller's, through cancelRunUseCase.
export const checkRunValidityUseCase = Effect.fn("checkRunValidityUseCase")(function* (
  runId: RunId,
) {
  const flows = yield* FlowsClient;

  const run = Option.filter(yield* (yield* RunsRepository).findOne(runId), RunRootOps.isRunning);

  const asking = Option.flatMap(run, (found) =>
    Option.map(Option.product(found.item, found.executionId), ([item, executionId]) => ({
      flow: { repo: found.repo, flow: found.flow, persona: found.persona },
      question: { runId: found.id, executionId, item, pullRequest: found.pullRequest },
    })),
  );

  if (Option.isNone(asking)) {
    return unchecked;
  }

  const answer = yield* Effect.result(flows.stillValid(asking.value.flow, asking.value.question));

  return Result.match(answer, {
    onFailure: (failure) => RunValidity.cases.CheckFailed.make({ message: failure.message }),
    onSuccess: (validity) =>
      Option.match(validity, { onNone: () => unchecked, onSome: toValidity }),
  });
});
