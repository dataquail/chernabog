// The repo a rehearsal seeds, over GitHub's REST API, each call as its
// persona. A seeded pull request's commits are written with the git data API
// (a tree and a commit each, on the base branch's head), so seeding needs no
// checkout.

import { type GitHubError, type Json } from "@chernabog/core";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { type Persona } from "../../../../kernel/persona.value-object.ts";
import { type IssueSeed, type PullRequestSeed } from "../../../../kernel/scenario.value-object.ts";
import {
  GitHubApi,
  githubGraphql,
  githubJson,
  githubRequest,
  githubSend,
} from "../../../../platform/github-api.ts";
import type { GitHubTokens } from "../../../../platform/github-auth.ts";
import { ScratchRepoClient } from "../../domain/ports/clients/scratch-repo.client.ts";
import { ScratchRepoFailed } from "../../domain/scenario/scenario.errors.ts";

const Numbered = Schema.Struct({ number: Schema.Finite });
const Sha = Schema.Struct({ sha: Schema.String });
const Ref = Schema.Struct({ object: Sha });
const Commit = Schema.Struct({ tree: Sha });
const RepoInfo = Schema.Struct({ default_branch: Schema.String });

const IssueInfo = Schema.Struct({
  node_id: Schema.String,
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  pull_request: Schema.optionalKey(Schema.Json),
});

const PullInfo = Schema.Struct({
  requested_reviewers: Schema.Array(Schema.Struct({ login: Schema.String })),
});

const Pulls = Schema.Array(Numbered);

const DELETED = Schema.Struct({ deleteIssue: Schema.Json });

// A list the request sends only when the seed gives one.
const listIn = (key: string, values: Option.Option<ReadonlyArray<string>>): Record<string, Json> =>
  Option.match(values, {
    onNone: () => ({}),
    onSome: (found) => ({ [key]: [...found] }),
  });

const failed = (what: string) => (error: GitHubError) =>
  new ScratchRepoFailed({ message: `${what}: ${error.message}` });

// One commit on `parent` that writes each of `files` whole.
const commitFiles = (
  repo: string,
  parent: string,
  message: string,
  files: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const base = yield* githubJson("GET", `/repos/${repo}/git/commits/${parent}`, Commit);

    const tree = yield* githubJson(
      "POST",
      `/repos/${repo}/git/trees`,
      Sha,
      Option.some({
        base_tree: base.tree.sha,
        tree: Object.entries(files).map(([path, content]) => ({
          path,
          mode: "100644",
          type: "blob",
          content,
        })),
      }),
    );

    const commit = yield* githubJson(
      "POST",
      `/repos/${repo}/git/commits`,
      Sha,
      Option.some({ message, tree: tree.sha, parents: [parent] }),
    );

    return commit.sha;
  });

const openPullRequest = (repo: string, base: string, seed: PullRequestSeed) =>
  Effect.gen(function* () {
    const head = yield* githubJson("GET", `/repos/${repo}/git/ref/heads/${base}`, Ref);
    let sha = head.object.sha;

    for (const commit of seed.commits) {
      sha = yield* commitFiles(repo, sha, commit.message, commit.files);
    }

    yield* githubSend(
      "POST",
      `/repos/${repo}/git/refs`,
      Option.some({ ref: `refs/heads/${seed.branch}`, sha }),
    );

    const pull = yield* githubJson(
      "POST",
      `/repos/${repo}/pulls`,
      Numbered,
      Option.some({ title: seed.title, body: seed.body ?? "", head: seed.branch, base }),
    );

    if ((seed.labels ?? []).length > 0) {
      yield* githubSend(
        "POST",
        `/repos/${repo}/issues/${pull.number}/labels`,
        Option.some({ labels: [...(seed.labels ?? [])] }),
      );
    }

    if ((seed.reviewers ?? []).length > 0) {
      yield* githubSend(
        "POST",
        `/repos/${repo}/pulls/${pull.number}/requested_reviewers`,
        Option.some({ reviewers: [...(seed.reviewers ?? [])] }),
      );
    }

    return pull.number;
  });

const openIssue = (repo: string, seed: IssueSeed) =>
  githubJson(
    "POST",
    `/repos/${repo}/issues`,
    Numbered,
    Option.some({
      title: seed.title,
      body: seed.body ?? "",
      ...listIn("labels", Option.fromUndefinedOr(seed.labels)),
      ...listIn("assignees", Option.fromUndefinedOr(seed.assignees)),
    }),
  ).pipe(Effect.map((issue) => issue.number));

const stateOf = (repo: string, number: number) =>
  Effect.gen(function* () {
    const issue = yield* githubJson("GET", `/repos/${repo}/issues/${number}`, IssueInfo);
    let reviewRequests: ReadonlyArray<string> = [];

    if (Option.isSome(Option.fromUndefinedOr(issue.pull_request))) {
      const pull = yield* githubJson("GET", `/repos/${repo}/pulls/${number}`, PullInfo);
      reviewRequests = pull.requested_reviewers.map((user) => user.login);
    }

    return { labels: issue.labels.map((label) => label.name), reviewRequests };
  });

// GitHub deletes an issue only for an admin of the repo; anyone else closes it.
const removeIssue = (repo: string, number: number) =>
  Effect.gen(function* () {
    const issue = yield* githubJson("GET", `/repos/${repo}/issues/${number}`, IssueInfo);

    const deleted = yield* Effect.result(
      githubGraphql(
        "mutation($id: ID!) { deleteIssue(input: { issueId: $id }) { clientMutationId } }",
        { id: issue.node_id },
        DELETED,
      ),
    );

    if (Result.isSuccess(deleted)) {
      return "deleted" as const;
    }

    yield* githubSend(
      "PATCH",
      `/repos/${repo}/issues/${number}`,
      Option.some({ state: "closed", state_reason: "not_planned" }),
    );

    return "closed" as const;
  });

// A branch already gone is as good as deleted.
const deleteBranch = (repo: string, branch: string) =>
  githubRequest("DELETE", `/repos/${repo}/git/refs/heads/${branch}`).pipe(
    Effect.flatMap((response) => {
      if (response.status < 300 || response.status === 404 || response.status === 422) {
        return Effect.void;
      }

      return Effect.fail(
        new ScratchRepoFailed({
          message: `deleting ${branch} in ${repo} returned HTTP ${response.status}`,
        }),
      );
    }),
  );

const ownerOf = (repo: string) => repo.slice(0, repo.indexOf("/"));

// The client over GitHub as `apiFor` reaches it for each persona.
export const scratchRepoClientWith = (apiFor: (persona: Persona) => Layer.Layer<GitHubApi>) => {
  // Each call as its persona, with that persona's token.
  const as =
    (persona: Persona, what: string) =>
    <A, E extends GitHubError | ScratchRepoFailed>(effect: Effect.Effect<A, E, GitHubApi>) =>
      effect.pipe(
        Effect.provide(apiFor(persona)),
        Effect.mapError((error): ScratchRepoFailed => {
          if (Predicate.isTagged(error, "ScratchRepoFailed")) {
            return error;
          }

          return failed(what)(error);
        }),
      );

  return ScratchRepoClient.of({
    defaultBranch: (repo, persona) =>
      githubJson("GET", `/repos/${repo}`, RepoInfo).pipe(
        Effect.map((info) => info.default_branch),
        as(persona, `reading ${repo}`),
      ),
    openIssue: (repo, seed, persona) =>
      openIssue(repo, seed).pipe(as(persona, `opening issue ${seed.name} in ${repo}`)),
    openPullRequest: (repo, base, seed, persona) =>
      openPullRequest(repo, base, seed).pipe(
        as(persona, `opening pull request ${seed.name} in ${repo}`),
      ),
    stateOf: (repo, number, persona) =>
      stateOf(repo, number).pipe(as(persona, `reading #${number} in ${repo}`)),
    pullRequestsFrom: (repo, branch, persona) =>
      githubJson(
        "GET",
        `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${ownerOf(repo)}:${branch}`)}`,
        Pulls,
      ).pipe(
        Effect.map((pulls) => pulls.map((pull) => pull.number)),
        as(persona, `listing pull requests from ${branch} in ${repo}`),
      ),
    removeIssue: (repo, number, persona) =>
      removeIssue(repo, number).pipe(as(persona, `removing issue #${number} in ${repo}`)),
    closePullRequest: (repo, number, persona) =>
      githubSend("PATCH", `/repos/${repo}/pulls/${number}`, Option.some({ state: "closed" })).pipe(
        Effect.asVoid,
        as(persona, `closing pull request #${number} in ${repo}`),
      ),
    deleteBranch: (repo, branch, persona) =>
      deleteBranch(repo, branch).pipe(as(persona, `deleting ${branch} in ${repo}`)),
  });
};

// Each persona's calls carry its own token, from GitHubTokens.
export const ScratchRepoClientLive = Layer.effect(
  ScratchRepoClient,
  Effect.map(Effect.context<GitHubTokens | HttpClient.HttpClient>(), (services) =>
    scratchRepoClientWith((persona) =>
      GitHubApi.layerFor(persona).pipe(Layer.provide(Layer.succeedContext(services))),
    ),
  ),
);
