// The protected-branch Progress adapter behind the acceptance tests' fake
// GitHub, whose commits, trees and blobs are a real bare repo: the contract
// every adapter passes, blobs and all, so the acceptance tests' records can
// carry them.

import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { makeThreadsProgress } from "../src/modules/runs/infrastructure/runtime/progress.ts";
import { Exec, execOk } from "../src/platform/exec.ts";
import { GitHubApi } from "../src/platform/github-api.ts";
import { GitHubTokens } from "../src/platform/github-auth.ts";
import { startFakeGitHub } from "./acceptance/fake-github.ts";
import { progressContract } from "./progress-contract.ts";

const SLUG = "dataquail/demo";
const PERSONA = Option.some("data-quail");

const initBare = (bare: string) =>
  execOk("git", ["init", "--quiet", "--bare", "--initial-branch", "main", bare]).pipe(
    Effect.provide(Exec.layer),
  );

// The API as the persona, at the fake GitHub's url.
const apiAt = (url: string) =>
  GitHubApi.layerFor(PERSONA).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(GitHubTokens.fixed("test-token")),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ CHERNABOG_GITHUB_API: url }))),
  );

const adapterAt = (url: string) =>
  makeThreadsProgress({ slug: SLUG, persona: PERSONA }).pipe(Effect.provide(apiAt(url)));

// A fake GitHub over an empty bare repo, stopped when the test ends.
const fakeGitHub = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-progress-" });
  const bare = `${root}/origin.git`;
  yield* initBare(bare);

  return yield* Effect.acquireRelease(
    Effect.sync(() => startFakeGitHub({ slug: SLUG, bare })),
    (started) => Effect.promise(() => started.stop()),
  );
});

progressContract(
  "protected branches on the fake GitHub",
  Effect.flatMap(fakeGitHub, (github) => adapterAt(github.url)),
);
