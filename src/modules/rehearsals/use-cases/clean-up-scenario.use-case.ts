import * as Effect from "effect/Effect";

import { type Persona } from "../../../kernel/persona.value-object.ts";
import { ScratchRepoClient } from "../domain/ports/clients/scratch-repo.client.ts";
import { type Seeded } from "../domain/scenario/seeded.value-object.ts";
import { CleanUp } from "./clean-up.result.ts";

// Removes what a rehearsal made on `repo`, as `as`: the seeded issues
// (deleted, or closed where the persona may not delete), the seeded pull
// requests and their branches, and the pull requests from `branches`, the
// ones the flow made, and those branches. It carries on past what fails, and
// says what that was.
export const cleanUpScenarioUseCase = Effect.fn("cleanUpScenarioUseCase")(function* (request: {
  readonly repo: string;
  readonly seeded: Seeded;
  readonly branches: ReadonlyArray<string>;
  readonly as: Persona;
}) {
  const client = yield* ScratchRepoClient;
  const removed: Array<string> = [];
  const failed: Array<string> = [];

  const attempt = <E extends { readonly message: string }>(
    what: string,
    effect: Effect.Effect<string, E>,
  ) =>
    Effect.match(effect, {
      onSuccess: (done) => removed.push(done),
      onFailure: (error) => failed.push(`${what}: ${error.message}`),
    });

  const { as, repo } = request;

  for (const branch of request.branches) {
    const pulls = yield* Effect.orElseSucceed(client.pullRequestsFrom(repo, branch, as), () => []);

    for (const number of pulls) {
      yield* attempt(
        `pull request #${number}`,
        Effect.as(client.closePullRequest(repo, number, as), `closed pull request #${number}`),
      );
    }
  }

  for (const pull of request.seeded.pullRequests.filter((known) => known.number > 0)) {
    yield* attempt(
      `pull request #${pull.number}`,
      Effect.as(
        client.closePullRequest(repo, pull.number, as),
        `closed pull request #${pull.number}`,
      ),
    );
  }

  for (const branch of [
    ...request.seeded.pullRequests.map((pull) => pull.branch),
    ...request.branches,
  ]) {
    yield* attempt(
      `branch ${branch}`,
      Effect.as(client.deleteBranch(repo, branch, as), `deleted branch ${branch}`),
    );
  }

  for (const issue of request.seeded.issues) {
    yield* attempt(
      `issue #${issue.number}`,
      Effect.map(
        client.removeIssue(repo, issue.number, as),
        (how) => `${how} issue #${issue.number}`,
      ),
    );
  }

  return CleanUp.make({ removed, failed });
});
