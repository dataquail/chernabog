import {
  DEFAULT_LABELS,
  Git,
  GitHub,
  GitHubCapability,
  GitHubError,
  HEADLESS,
  type Json,
  MergeRefused,
  PushRejected,
  type RepoSettings,
  Worktree,
} from "@chernabog/core";
import { describe, expect } from "bun:test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { effect, effectAtHomeWith } from "../../../../../test/effect-test.ts";
import { Exec, execOk } from "../../../../platform/exec.ts";
import { GitHubApi } from "../../../../platform/github-api.ts";
import { GitHubTokens } from "../../../../platform/github-auth.ts";
import { DEFAULT_LIMITS } from "../../../../repo-config.ts";
import { GitHubLive, GitLive, pushRejection, WorktreeLive } from "./sdk-live.ts";

const settings: RepoSettings = {
  name: "demo",
  slug: "dataquail/demo",
  path: "/tmp/demo",
  baseBranch: "main",
  account: {
    name: "work",
    configDir: Option.none(),
    expectedEmail: Option.none(),
    oauthTokenEnv: Option.none<string>(),
    usageGate: "usage" as const,
  },
  agent: "claude",
  agentAccounts: {},
  launcher: HEADLESS,
  flowAgents: {},
  labels: DEFAULT_LABELS,
  install: Option.none(),
  localGate: [],
  humanOnly: [],
  humanOnlyPaths: [],
  notes: [],
  board: Option.none(),
  reviewTrigger: Option.none(),
  limits: DEFAULT_LIMITS,
  env: {},
  configDir: "/tmp/demo/.chernabog",
};

// GitHub answering every request with one status and body, and the requests it got.
const answering = (status: number, body: Option.Option<Json>) => {
  const requests: Array<{
    readonly method: string;
    readonly path: string;
    readonly body: Option.Option<Json>;
  }> = [];

  const api = Layer.succeed(
    GitHubApi,
    GitHubApi.of({
      request: (method, path, sent) =>
        Effect.sync(() => {
          requests.push({ method, path, body: sent });

          return { status, body, nextUrl: Option.none(), headers: {} };
        }),
    }),
  );

  return { requests, layer: GitHubLive(settings).pipe(Layer.provide(api)) };
};

const mergeWith = (status: number, body: Option.Option<Json>) => {
  const github = answering(status, body);

  return GitHub.use((service) => service.merge(7, { method: "squash", sha: "abc1234" })).pipe(
    Effect.result,
    Effect.provide(github.layer),
    Effect.map((outcome) => ({ outcome, requests: github.requests })),
  );
};

effect("a merge asks GitHub to merge exactly the reviewed head, by the method given", () =>
  Effect.gen(function* () {
    const { outcome, requests } = yield* mergeWith(
      200,
      Option.some({ sha: "merged9876", merged: true }),
    );

    expect(outcome).toEqual(Result.succeed({ sha: "merged9876" }));
    expect(requests).toEqual([
      {
        method: "PUT",
        path: "/repos/dataquail/demo/pulls/7/merge",
        body: Option.some({ merge_method: "squash", sha: "abc1234" }),
      },
    ]);
  }),
);

effect(
  "GitHub's refusals fail with MergeRefused and its reason, and other failures as errors",
  () =>
    Effect.gen(function* () {
      expect(
        (yield* mergeWith(
          405,
          Option.some({ message: 'Required status check "test" is expected.' }),
        )).outcome,
      ).toEqual(
        Result.fail(
          new MergeRefused({
            pullRequest: 7,
            reason: 'GitHub refused the merge: Required status check "test" is expected.',
          }),
        ),
      );
      expect((yield* mergeWith(409, Option.none())).outcome).toEqual(
        Result.fail(
          new MergeRefused({ pullRequest: 7, reason: "GitHub refused the merge (HTTP 409)" }),
        ),
      );
      expect((yield* mergeWith(500, Option.none())).outcome).toEqual(
        Result.fail(new GitHubError({ message: "merging #7 returned HTTP 500" })),
      );
    }),
);

effect(
  "a push GitHub refuses for a token without the workflow scope is PushRejected, naming the scope; a moved branch is PushRejected without one",
  () =>
    Effect.gen(function* () {
      const refused = [
        "exited 1: To https://github.com/dataquail/demo.git",
        " ! [remote rejected] HEAD -> auto/issue-3 (refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)",
        "error: failed to push some refs to 'https://github.com/dataquail/demo.git'",
      ].join("\n");

      expect(pushRejection("auto/issue-3", refused)).toEqual(
        Option.some(
          new PushRejected({
            branch: "auto/issue-3",
            reason:
              "! [remote rejected] HEAD -> auto/issue-3 (refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)",
            missingScope: "workflow",
          }),
        ),
      );

      const stale = pushRejection(
        "auto/issue-3",
        "exited 1: To https://github.com/dataquail/demo.git\n ! [rejected]        HEAD -> auto/issue-3 (stale info)",
      );

      expect(stale).toEqual(
        Option.some(
          new PushRejected({
            branch: "auto/issue-3",
            reason: "! [rejected]        HEAD -> auto/issue-3 (stale info)",
          }),
        ),
      );

      expect(
        pushRejection(
          "auto/issue-3",
          "exited 128: fatal: unable to access 'https://github.com/dataquail/demo.git/'",
        ),
      ).toEqual(Option.none());
      yield* Effect.void;
    }),
);

const CLAIM = "refs/chernabog/claims/issue-3";

const onGitHub = <A, E>(
  github: ReturnType<typeof answering>,
  use: (service: GitHub["Service"]) => Effect.Effect<A, E>,
) => GitHub.use(use).pipe(Effect.result, Effect.provide(github.layer));

effect(
  "a claim ref is created by its full name, and a second create of it says it already exists",
  () =>
    Effect.gen(function* () {
      const created = answering(201, Option.some({ ref: CLAIM }));
      expect(yield* onGitHub(created, (service) => service.createRef(CLAIM, "c1"))).toEqual(
        Result.succeed("created"),
      );
      expect(created.requests).toEqual([
        {
          method: "POST",
          path: "/repos/dataquail/demo/git/refs",
          body: Option.some({ ref: CLAIM, sha: "c1" }),
        },
      ]);

      const taken = answering(422, Option.some({ message: "Reference already exists" }));
      expect(yield* onGitHub(taken, (service) => service.createRef(CLAIM, "c1"))).toEqual(
        Result.succeed("already-exists"),
      );
    }),
);

effect("a claim ref GitHub doesn't have reads as none, and deleting one is not an error", () =>
  Effect.gen(function* () {
    const missing = answering(404, Option.none());
    expect(yield* onGitHub(missing, (service) => service.ref(CLAIM))).toEqual(
      Result.succeed(Option.none()),
    );
    expect(missing.requests.map((request) => request.path)).toEqual([
      "/repos/dataquail/demo/git/ref/chernabog/claims/issue-3",
    ]);

    const gone = answering(422, Option.some({ message: "Reference does not exist" }));
    expect(Result.isSuccess(yield* onGitHub(gone, (service) => service.deleteRef(CLAIM)))).toBe(
      true,
    );
    expect(gone.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "DELETE /repos/dataquail/demo/git/refs/chernabog/claims/issue-3",
    ]);
  }),
);

effect("moving a claim ref is a forced update, and a refusal is an error", () =>
  Effect.gen(function* () {
    const moved = answering(200, Option.some({ ref: CLAIM }));
    expect(
      Result.isSuccess(yield* onGitHub(moved, (service) => service.updateRef(CLAIM, "c2"))),
    ).toBe(true);
    expect(moved.requests).toEqual([
      {
        method: "PATCH",
        path: "/repos/dataquail/demo/git/refs/chernabog/claims/issue-3",
        body: Option.some({ sha: "c2", force: true }),
      },
    ]);

    const refused = answering(422, Option.some({ message: "Reference does not exist" }));
    expect(
      Result.isFailure(yield* onGitHub(refused, (service) => service.updateRef(CLAIM, "c2"))),
    ).toBe(true);
  }),
);

effect(
  "a commit made through the API is its message, tree and parents, and comes back as its sha",
  () =>
    Effect.gen(function* () {
      const made = answering(201, Option.some({ sha: "c1", message: "chernabog claim" }));
      expect(
        yield* onGitHub(made, (service) =>
          service.createCommit({ message: "chernabog claim", tree: "t1", parents: [] }),
        ),
      ).toEqual(Result.succeed("c1"));
      expect(made.requests).toEqual([
        {
          method: "POST",
          path: "/repos/dataquail/demo/git/commits",
          body: Option.some({ message: "chernabog claim", tree: "t1", parents: [] }),
        },
      ]);
    }),
);

// GitHub answering each request by its method and path, and the requests it got.
const routing = (answer: (method: string, path: string) => { body: Json; status: number }) => {
  const requests: Array<string> = [];

  const api = Layer.succeed(
    GitHubApi,
    GitHubApi.of({
      request: (method, path) =>
        Effect.sync(() => {
          requests.push(`${method} ${path}`);
          const { body, status } = answer(method, path);

          return { status, body: Option.some(body), nextUrl: Option.none(), headers: {} };
        }),
    }),
  );

  return { requests, layer: GitHubLive(settings).pipe(Layer.provide(api)) };
};

const restIssue = (number: number, state = "open") => ({
  id: 9000 + number,
  number,
  title: `Issue ${number}`,
  body: "Do it.",
  html_url: `https://github.com/dataquail/demo/issues/${number}`,
  created_at: "2026-10-20T00:00:00Z",
  labels: [],
  state,
});

effect(
  "sub-issues and blockers are linked by the issue's id, and a link already there stays",
  () => {
    const github = routing((method, path) => {
      if (path.endsWith("/issues/3/sub_issues?per_page=100")) {
        return { status: 200, body: [restIssue(12)] };
      }

      if (path.endsWith("/issues/14/dependencies/blocked_by?per_page=100")) {
        return { status: 200, body: [restIssue(12, "closed")] };
      }

      if (method === "GET" && path.endsWith("/issues/13")) {
        return { status: 200, body: restIssue(13) };
      }

      return { status: 201, body: {} };
    });

    return Effect.gen(function* () {
      const service = yield* GitHub;
      yield* service.addSubIssue(3, 12);
      yield* service.addSubIssue(3, 13);
      yield* service.addBlockedBy(14, 12);
      yield* service.addBlockedBy(14, 13);

      const linked = yield* service.blockedBy(14);
      expect(linked.map((issue) => [issue.number, issue.state])).toEqual([[12, "closed"]]);
      expect(github.requests.filter((request) => request.startsWith("POST"))).toEqual([
        "POST /repos/dataquail/demo/issues/3/sub_issues",
        "POST /repos/dataquail/demo/issues/14/dependencies/blocked_by",
      ]);
    }).pipe(Effect.provide(github.layer));
  },
);

effect("unlinking a blocker deletes by its id, and one that isn't linked is not an error", () => {
  const github = routing((method, path) => {
    if (method === "GET") {
      return { status: 200, body: restIssue(Number(path.split("/").at(-1))) };
    }

    return { status: 404, body: { message: "Not Found" } };
  });

  return Effect.gen(function* () {
    yield* (yield* GitHub).removeBlockedBy(14, 12);

    expect(github.requests).toEqual([
      "GET /repos/dataquail/demo/issues/12",
      "DELETE /repos/dataquail/demo/issues/14/dependencies/blocked_by/9012",
    ]);
  }).pipe(Effect.provide(github.layer));
});

effect("a new issue is opened with its title, body and labels", () => {
  const github = routing(() => ({ status: 201, body: restIssue(20) }));

  return Effect.gen(function* () {
    const created = yield* (yield* GitHub).createIssue({
      title: "Issue 20",
      body: "Do it.",
      labels: ["auto:eligible"],
    });

    expect(created.number).toBe(20);
    expect(github.requests).toEqual(["POST /repos/dataquail/demo/issues"]);
  }).pipe(Effect.provide(github.layer));
});

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execOk("git", ["-C", cwd, ...args]).pipe(Effect.map((said) => said.trim()));

// A bare origin with main at one commit, and a clone of it as the repo's checkout.
class GitRepo extends Context.Service<
  GitRepo,
  { readonly origin: string; readonly checkout: string; readonly base: string }
>()("test/GitRepo") {}

// The repo, and the run's Worktree and Git over its checkout, as the implicit persona.
const gitRepo = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-git-" });

    const root = yield* fs.realPath(temporary);
    const origin = `${root}/origin.git`;
    const checkout = `${root}/checkout`;

    yield* execOk("git", ["init", "--quiet", "--bare", "--initial-branch", "main", origin]);
    yield* execOk("git", ["clone", "--quiet", origin, checkout]);
    yield* git(checkout, "config", "user.email", "test@example.com");
    yield* git(checkout, "config", "user.name", "Test");
    yield* git(checkout, "commit", "--quiet", "--allow-empty", "-m", "base");
    yield* git(checkout, "push", "--quiet", "origin", "HEAD:refs/heads/main");

    const base = yield* git(checkout, "rev-parse", "HEAD");

    return Layer.mergeAll(
      Layer.succeed(GitRepo, GitRepo.of({ origin, checkout, base })),
      WorktreeLive({ ...settings, path: checkout }, Option.none()),
      GitLive(Option.none()),
    ).pipe(Layer.provide(GitHubTokens.fixed("token")));
  }).pipe(Effect.orDie),
);

// A call of every member of GitHub, so a test can see what each one asks of GitHub.
const EVERY_MEMBER = {
  queuedIssues: (github) => github.queuedIssues,
  queuedIssuesLabelled: (github) => github.queuedIssuesLabelled("auto:eligible"),
  oldestQueued: (github) => github.oldestQueued,
  issuesLabelled: (github) => github.issuesLabelled("auto:eligible"),
  issue: (github) => github.issue(3),
  createIssue: (github) => github.createIssue({ title: "a task", body: "", labels: [] }),
  subIssues: (github) => github.subIssues(3),
  addSubIssue: (github) => github.addSubIssue(3, 5),
  blockedBy: (github) => github.blockedBy(3),
  addBlockedBy: (github) => github.addBlockedBy(3, 4),
  removeBlockedBy: (github) => github.removeBlockedBy(3, 4),
  trustedComments: (github) => github.trustedComments(3),
  comments: (github) => github.comments(3),
  comment: (github) => github.comment(3, "hello"),
  addLabel: (github) => github.addLabel(3, "auto:eligible"),
  removeLabel: (github) => github.removeLabel(3, "auto:eligible"),
  moveToStatus: (github) => github.moveToStatus(3, "Done"),
  assignSelf: (github) => github.assignSelf(3),
  login: (github) => github.login,
  branchSha: (github) => github.branchSha("auto/issue-3"),
  createBranch: (github) => github.createBranch("auto/issue-3", "c1"),
  deleteBranch: (github) => github.deleteBranch("auto/issue-3"),
  createCommit: (github) => github.createCommit({ message: "m", tree: "t1", parents: [] }),
  createRef: (github) => github.createRef(CLAIM, "c1"),
  ref: (github) => github.ref(CLAIM),
  deleteRef: (github) => github.deleteRef(CLAIM),
  updateRef: (github) => github.updateRef(CLAIM, "c2"),
  pullRequest: (github) => github.pullRequest(7),
  pullRequestForBranch: (github) => github.pullRequestForBranch("auto/issue-3"),
  pullRequestsLabelled: (github) => github.pullRequestsLabelled("auto:needs-review"),
  openPullRequests: (github) => github.openPullRequests,
  requestReviewers: (github) => github.requestReviewers(7, ["zach"]),
  reviews: (github) => github.reviews(7),
  openPullRequest: (github) =>
    github.openPullRequest({ head: "auto/issue-3", base: "main", title: "t", body: "b" }),
  ciState: (github) => github.ciState(7),
  commitCiState: (github) => github.commitCiState("c1"),
  branchCiState: (github) => github.branchCiState("main"),
  ciFailureDetails: (github) =>
    github.ciFailureDetails({
      name: "test",
      url: "https://github.com/dataquail/demo/actions/runs/1",
      job: Option.some(1),
      workflowRun: Option.some(1),
    }),
  pullRequestFiles: (github) => github.pullRequestFiles(7),
  closedPullRequestsLabelled: (github) => github.closedPullRequestsLabelled("auto:stale"),
  review: (github) =>
    github.review(7, { body: "ok", commitSha: "c1", comments: [], event: "APPROVE" }),
  reviewComments: (github) => github.reviewComments(7),
  merge: (github) => github.merge(7, { method: "squash", sha: "c1" }),
  request: (github) => github.request("GET", "/repos/dataquail/demo", Option.none()),
} satisfies {
  readonly [K in keyof GitHub["Service"]]: (
    github: GitHub["Service"],
  ) => Effect.Effect<unknown, unknown>;
};

const GraphqlRequest = Schema.Struct({ query: Schema.String });

// A request that changes something on GitHub: a GraphQL mutation, or any other request but a GET.
const writes = (request: {
  readonly method: string;
  readonly path: string;
  readonly body: Option.Option<Json>;
}) => {
  if (request.path === "/graphql") {
    return Option.exists(
      Option.flatMap(request.body, Schema.decodeUnknownOption(GraphqlRequest)),
      (sent) => sent.query.trimStart().startsWith("mutation"),
    );
  }

  return request.method !== "GET";
};

effect("every member of GitHub that writes to it is declared a write, a claim, or local", () =>
  Effect.gen(function* () {
    const writing = yield* Effect.forEach(Object.entries(EVERY_MEMBER), ([name, call]) =>
      Effect.gen(function* () {
        const github = answering(200, Option.some({}));
        yield* onGitHub(github, (service) => Effect.asVoid<unknown, unknown, never>(call(service)));

        return { name, wrote: github.requests.some(writes) };
      }),
    ).pipe(Effect.map((found) => found.filter((member) => member.wrote).map(({ name }) => name)));

    const declared = new Set(
      Result.getOrElse(
        yield* onGitHub(answering(200, Option.none()), (github) =>
          Effect.succeed(Object.keys(GitHubCapability.writes(github, (method) => method))),
        ),
        () => [],
      ),
    );

    const undeclared = writing.filter(
      (name) =>
        !declared.has(name) &&
        !Object.entries(GitHubCapability.others).some(
          ([other, kind]) => other === name && kind !== "read",
        ),
    );

    expect(writing).toContain("comment");
    expect(undeclared).toEqual([]);
  }),
);

// git runs for real.
const atHome = effectAtHomeWith(Exec.layer);

describe("WorktreeLive", () => {
  atHome(
    "a worktree an earlier run left is reset to the claimed branch, and its push succeeds",
    () =>
      Effect.gen(function* () {
        const { base, checkout, origin } = yield* GitRepo;
        const worktree = yield* Worktree;
        const pusher = yield* Git;
        const branch = "auto/issue-7";

        // The earlier run: its work pushed, then the branch deleted from the checkout.
        const left = yield* worktree.ensure(branch, "run-old");
        yield* git(left, "commit", "--quiet", "--allow-empty", "-m", "old work");
        yield* pusher.push(left, branch);
        yield* git(checkout, "push", "--quiet", "origin", "--delete", branch);

        // This run's claim makes the branch again, at main, through the API.
        yield* git(origin, "update-ref", `refs/heads/${branch}`, base);

        const path = yield* worktree.ensure(branch, "run-new");
        expect(path).toBe(left);
        expect(yield* git(path, "rev-parse", "HEAD")).toBe(base);

        yield* git(path, "commit", "--quiet", "--allow-empty", "-m", "new work");
        yield* pusher.push(path, branch);

        expect(yield* git(origin, "rev-parse", branch)).toBe(yield* git(path, "rev-parse", "HEAD"));
      }).pipe(Effect.provide(gitRepo)),
  );

  atHome("a run resuming its own worktree keeps its work", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const worktree = yield* Worktree;
      const branch = "auto/issue-7";

      const path = yield* worktree.ensure(branch, "run-1");
      yield* git(path, "commit", "--quiet", "--allow-empty", "-m", "committed work");
      const head = yield* git(path, "rev-parse", "HEAD");
      yield* fs.writeFileString(`${path}/draft.txt`, "uncommitted\n");

      expect(yield* worktree.ensure(branch, "run-1")).toBe(path);
      expect(yield* git(path, "rev-parse", "HEAD")).toBe(head);
      expect(yield* fs.readFileString(`${path}/draft.txt`)).toBe("uncommitted\n");
    }).pipe(Effect.provide(gitRepo)),
  );

  // #212: each run's worktree writes its branch's upstream into the checkout's
  // one .git/config, and git refuses a second writer while the first holds its lock.
  atHome("runs preparing worktrees at once all get them", () =>
    Effect.gen(function* () {
      const { base, origin } = yield* GitRepo;
      const worktree = yield* Worktree;
      const runs = 8;
      const branches = Array.from({ length: runs }, (_, index) => `auto/issue-${index + 1}`);

      for (const branch of branches) {
        yield* git(origin, "update-ref", `refs/heads/${branch}`, base);
      }

      const paths = yield* Effect.forEach(
        branches,
        (branch, index) => worktree.ensure(branch, `run-${index + 1}`),
        { concurrency: runs },
      );

      for (const path of paths) {
        expect(yield* git(path, "rev-parse", "HEAD")).toBe(base);
      }
    }).pipe(Effect.provide(gitRepo)),
  );

  // Another process's git, such as `chernabog run`'s, holding a lock for a moment.
  atHome("a worktree waits out a lock another git holds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { base, checkout, origin } = yield* GitRepo;
      const worktree = yield* Worktree;
      const branch = "auto/issue-7";
      const lock = `${checkout}/.git/config.lock`;

      yield* git(origin, "update-ref", `refs/heads/${branch}`, base);
      yield* fs.writeFileString(lock, "");

      const released = Effect.delay(fs.remove(lock), "300 millis");

      const [path] = yield* Effect.all([worktree.ensure(branch, "run-1"), released], {
        concurrency: "unbounded",
      });

      expect(yield* git(path, "rev-parse", "HEAD")).toBe(base);
      expect(yield* git(path, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(`origin/${branch}`);
    }).pipe(Effect.provide(gitRepo)),
  );
});
