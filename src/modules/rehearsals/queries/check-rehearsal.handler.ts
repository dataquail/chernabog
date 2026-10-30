import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ScratchRepoClient } from "../domain/ports/clients/scratch-repo.client.ts";
import { ScenarioRootOps } from "../domain/scenario/scenario.root-ops.ts";
import { type CheckRehearsalPayload, RehearsalCheck } from "./check-rehearsal.query.ts";

export const checkRehearsalHandler = Effect.fn("checkRehearsalHandler")(function* (
  request: CheckRehearsalPayload,
) {
  const client = yield* ScratchRepoClient;
  const repo = request.scenario.repo;

  const labels = yield* Option.match(ScenarioRootOps.numberOf(request.item), {
    onNone: () => Effect.succeed<ReadonlyArray<string>>([]),
    onSome: (number) =>
      Effect.map(client.stateOf(repo, number, request.as), (state) => state.labels),
  });

  const opened = yield* Effect.forEach(request.branches, (branch) =>
    client.pullRequestsFrom(repo, branch, request.as),
  );

  const pullRequests = [
    ...new Set([
      ...request.seeded.pullRequests.map((pull) => pull.number).filter((number) => number > 0),
      ...opened.flat(),
    ]),
  ];

  const reviewRequests = yield* Effect.forEach(pullRequests, (pullRequest) =>
    Effect.map(client.stateOf(repo, pullRequest, request.as), (state) => ({
      pullRequest,
      logins: state.reviewRequests,
    })),
  );

  return RehearsalCheck.make({
    labels,
    missed: ScenarioRootOps.missed(request.scenario, {
      ending: request.ending,
      summary: request.summary,
      labels,
    }),
    reviewRequests: reviewRequests.filter((asked) => asked.logins.length > 0),
    unused: ScenarioRootOps.unused(request.standIns, request.asked),
  });
});
