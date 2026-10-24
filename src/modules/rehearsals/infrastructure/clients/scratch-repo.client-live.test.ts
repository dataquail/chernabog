import { type Json } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { githubTestLayer } from "../../../../platform/github-api.ts";
import { scratchRepoClientWith } from "./scratch-repo.client-live.ts";

const REPO = "you/scratch";

// GitHub as a table of answers, recording each request with the persona it came as.
const github = (answers: ReadonlyArray<readonly [string, number, Json]>) => {
  const requests: Array<{ as: string; request: string; body: Option.Option<Json> }> = [];

  const client = scratchRepoClientWith((persona) =>
    githubTestLayer((method, path, body) => {
      const request = `${method} ${path}`;
      requests.push({ as: Option.getOrElse(persona, () => "implicit"), request, body });

      return Option.map(
        Option.fromUndefinedOr(answers.find(([pattern]) => request.startsWith(pattern))),
        ([, status, answer]) => ({ status, body: answer }),
      );
    }),
  );

  return { client, requests };
};

describe("ScratchRepoClientLive", () => {
  effect("a pull request is seeded from a branch with its commits, as the persona", () =>
    Effect.gen(function* () {
      const { client, requests } = github([
        [`GET /repos/${REPO}/git/ref/heads/main`, 200, { object: { sha: "base1" } }],
        [`GET /repos/${REPO}/git/commits/`, 200, { tree: { sha: "tree0" } }],
        [`POST /repos/${REPO}/git/trees`, 201, { sha: "tree1" }],
        [`POST /repos/${REPO}/git/commits`, 201, { sha: "commit1" }],
        [`POST /repos/${REPO}/git/refs`, 201, {}],
        [`POST /repos/${REPO}/pulls/8/requested_reviewers`, 201, {}],
        [`POST /repos/${REPO}/pulls`, 201, { number: 8 }],
        [`POST /repos/${REPO}/issues/8/labels`, 200, []],
      ]);

      const number = yield* client.openPullRequest(
        REPO,
        "main",
        {
          name: "fix",
          branch: "rehearsal/fix",
          title: "Fix it",
          labels: ["auto:needs-review"],
          reviewers: ["bob"],
          commits: [{ message: "Fix it", files: { "src/fix.ts": "export {};\n" } }],
        },
        Option.some("alice"),
      );

      expect(number).toBe(8);
      expect(requests.every((request) => request.as === "alice")).toBe(true);

      const sent = (request: string) =>
        Option.flatMap(
          Option.fromUndefinedOr(requests.find((found) => found.request === request)),
          (found) => found.body,
        );

      expect(sent(`POST /repos/${REPO}/git/commits`)).toEqual(
        Option.some({ message: "Fix it", tree: "tree1", parents: ["base1"] }),
      );
      expect(sent(`POST /repos/${REPO}/git/refs`)).toEqual(
        Option.some({ ref: "refs/heads/rehearsal/fix", sha: "commit1" }),
      );
      expect(sent(`POST /repos/${REPO}/pulls/8/requested_reviewers`)).toEqual(
        Option.some({ reviewers: ["bob"] }),
      );
    }),
  );

  effect("an issue is deleted, or closed for a persona GitHub won't let delete it", () =>
    Effect.gen(function* () {
      const issue = { node_id: "I_1", labels: [] };

      const admin = github([
        [`GET /repos/${REPO}/issues/5`, 200, issue],
        ["POST /graphql", 200, { data: { deleteIssue: {} } }],
      ]);

      expect(yield* admin.client.removeIssue(REPO, 5, Option.none())).toBe("deleted");

      const writer = github([
        [`GET /repos/${REPO}/issues/5`, 200, issue],
        ["POST /graphql", 200, { errors: [{ message: "must be an admin" }] }],
        [`PATCH /repos/${REPO}/issues/5`, 200, {}],
      ]);

      expect(yield* writer.client.removeIssue(REPO, 5, Option.none())).toBe("closed");
    }),
  );

  effect("a pull request's state carries who it still asks to review it", () =>
    Effect.gen(function* () {
      const { client } = github([
        [
          `GET /repos/${REPO}/issues/8`,
          200,
          { node_id: "PR_8", labels: [{ name: "auto:needs-review" }], pull_request: {} },
        ],
        [`GET /repos/${REPO}/pulls/8`, 200, { requested_reviewers: [{ login: "bob" }] }],
      ]);

      expect(yield* client.stateOf(REPO, 8, Option.none())).toEqual({
        labels: ["auto:needs-review"],
        reviewRequests: ["bob"],
      });
    }),
  );

  effect("a branch already gone is deleted; a refused delete is a failure", () =>
    Effect.gen(function* () {
      const gone = github([[`DELETE /repos/${REPO}/git/refs/heads/auto/issue-3`, 422, {}]]);
      yield* gone.client.deleteBranch(REPO, "auto/issue-3", Option.none());

      const refused = github([[`DELETE /repos/${REPO}/git/refs/heads/auto/issue-3`, 403, {}]]);

      const failure = yield* Effect.flip(
        refused.client.deleteBranch(REPO, "auto/issue-3", Option.none()),
      );

      expect(failure.message).toContain("HTTP 403");
    }),
  );
});
