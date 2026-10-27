import {
  DEFAULT_LABELS,
  GitHub,
  GitHubError,
  HEADLESS,
  type Json,
  MergeRefused,
  PushRejected,
  type RepoSettings,
} from "@chernabog/sdk";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { effect } from "../../../../../test/effect-test.ts";
import { GitHubApi } from "../../../../platform/github-api.ts";
import { DEFAULT_LIMITS } from "../../../../repo-config.ts";
import { GitHubLive, pushRejection } from "./sdk-live.ts";

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

          return { status, body, nextUrl: Option.none() };
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
