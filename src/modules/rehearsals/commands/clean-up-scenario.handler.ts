import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { ScratchRepoClient } from "../domain/ports/clients/scratch-repo.client.ts";
import { CleanUp, type CleanUpScenarioPayload } from "./clean-up-scenario.command.ts";

export const cleanUpScenarioHandler = Effect.fn("cleanUpScenarioHandler")(
  function* (request: CleanUpScenarioPayload) {
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
      const pulls = yield* Effect.orElseSucceed(
        client.pullRequestsFrom(repo, branch, as),
        () => [],
      );

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

    // Each claim ref goes only while it names the run: one another run took
    // over is that run's.
    for (const claim of request.run.claims) {
      const released = yield* Effect.result(client.releaseClaimRef(repo, claim, as));

      if (Result.isFailure(released)) {
        failed.push(`claim ref on ${claim.item}: ${released.failure.message}`);
      }

      for (const ref of Option.toArray(Option.flatten(Result.getSuccess(released)))) {
        removed.push(`deleted claim ref ${ref}`);
      }
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

    const seededIssues = request.seeded.issues.map((issue) => issue.number);

    for (const number of Arr.dedupe(request.run.createdIssues)) {
      if (seededIssues.includes(number)) {
        continue;
      }

      yield* attempt(
        `issue #${number}`,
        Effect.map(
          client.removeIssue(repo, number, as),
          (how) => `${how} issue #${number} (the run created it)`,
        ),
      );
    }

    return CleanUp.make({ removed, failed });
  },
  withUnitOfWork,
  // Its stores are files on this machine: they have no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
