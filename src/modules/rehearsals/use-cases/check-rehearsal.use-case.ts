import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type Persona } from "../../../kernel/persona.value-object.ts";
import { type Ending } from "../../../kernel/scenario.value-object.ts";
import { type StandIns } from "../../../kernel/stand-in.value-object.ts";
import { ScratchRepoClient } from "../domain/ports/clients/scratch-repo.client.ts";
import { type ScenarioRoot } from "../domain/scenario/scenario.root.ts";
import { ScenarioRootOps } from "../domain/scenario/scenario.root-ops.ts";
import { type Seeded } from "../domain/scenario/seeded.value-object.ts";
import { RehearsalCheck } from "./rehearsal-check.result.ts";

// Reads back what a rehearsal's run left on GitHub, as `as`, and compares it
// with the scenario's expect:. `item` is the key of the work item it ran on;
// `branches` are the ones the flow made for it, such as auto/issue-12, whose
// pull requests are checked for review requests beside the seeded ones. A
// stand-in no step used is reported: a replayed step the flow no longer has.
export const checkRehearsalUseCase = Effect.fn("checkRehearsalUseCase")(function* (request: {
  readonly scenario: ScenarioRoot;
  readonly seeded: Seeded;
  readonly item: string;
  readonly ending: Ending;
  readonly summary: string;
  readonly branches: ReadonlyArray<string>;
  // The stand-ins it ran with, and the steps that asked the agent.
  readonly standIns: StandIns;
  readonly asked: ReadonlyArray<string>;
  readonly as: Persona;
}) {
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
