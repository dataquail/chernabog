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
