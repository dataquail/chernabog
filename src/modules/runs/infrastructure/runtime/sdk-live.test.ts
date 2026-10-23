import {
  DEFAULT_LABELS,
  GitHub,
  GitHubError,
  HEADLESS,
  type Json,
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
import { GitHubLive } from "./sdk-live.ts";

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

    expect(outcome).toEqual(Result.succeed({ status: "merged", sha: "merged9876" }));
    expect(requests).toEqual([
      {
        method: "PUT",
        path: "/repos/dataquail/demo/pulls/7/merge",
        body: Option.some({ merge_method: "squash", sha: "abc1234" }),
      },
    ]);
  }),
);

effect("GitHub's refusals come back as reasons, and other failures as errors", () =>
  Effect.gen(function* () {
    expect(
      (yield* mergeWith(405, Option.some({ message: 'Required status check "test" is expected.' })))
        .outcome,
    ).toEqual(
      Result.succeed({
        status: "refused",
        reason: 'GitHub refused the merge: Required status check "test" is expected.',
      }),
    );
    expect((yield* mergeWith(409, Option.none())).outcome).toEqual(
      Result.succeed({ status: "refused", reason: "GitHub refused the merge (HTTP 409)" }),
    );
    expect((yield* mergeWith(500, Option.none())).outcome).toEqual(
      Result.fail(new GitHubError({ message: "merging #7 returned HTTP 500" })),
    );
  }),
);
