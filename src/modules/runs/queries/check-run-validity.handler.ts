import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { FlowsClient } from "../domain/ports/clients/flows.client.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunSpecifications } from "../domain/run/run.specification.ts";
import { RunsRepository } from "../domain/run/runs.repository.ts";
import { type ItemValidity } from "../domain/run/work-item.value-object.ts";
import { RunValidity } from "../domain/schedule/validity.value-object.ts";
import { type CheckRunValidityPayload } from "./check-run-validity.query.ts";

const unchecked = RunValidity.cases.Unchecked.make({});

const toValidity = (validity: ItemValidity): RunValidity => {
  if (validity.valid) {
    return RunValidity.cases.Valid.make({});
  }

  return RunValidity.cases.Gone.make({ reason: validity.reason });
};

export const checkRunValidityHandler = Effect.fn("checkRunValidityHandler")(function* ({
  runId,
}: CheckRunValidityPayload) {
  const flows = yield* FlowsClient;

  const run = Option.filter(
    yield* (yield* RunsRepository).findOne(RunSpecifications.withId(runId)),
    RunRootOps.isRunning,
  );

  const asking = Option.flatMap(run, (found) =>
    Option.map(Option.product(found.item, found.executionId), ([item, executionId]) => ({
      flow: { repo: found.repo, flow: found.flow, persona: found.persona },
      question: { runId: found.id, executionId, item, subjects: found.subjects },
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
