// A step's process acts as the run's persona: it gets the persona's token in
// its environment, and nothing extra for the implicit persona.

import { StepRunner } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { GitHubTokens } from "../src/github-auth.ts";
import { StepRunnerLive } from "../src/steps.ts";
import { effect } from "./effect-test.ts";
import { settings } from "./sdk-fakes.ts";

const DEFAULT_GATE = {
  targetEndUsage: 0.95,
  taskCostEstimate: 0.04,
  fiveHourCeiling: 0.4,
  humanRatePerHour: 0.005,
};

// A repo whose one step prints the token it ran with.
const repoWithTokenStep = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-step-runner-" });
  yield* fs.makeDirectory(`${path}/.chernabog/stages`, { recursive: true });
  yield* fs.writeFileString(
    `${path}/.chernabog/stages/token`,
    '#!/bin/sh\ncat >/dev/null\nprintf \'{"token":"%s"}\\n\' "${GH_TOKEN:-none}"\n',
  );
  yield* fs.chmod(`${path}/.chernabog/stages/token`, 0o755);

  return { ...settings, path, configDir: `${path}/.chernabog` };
});

// The step runner as the persona, over that repo.
const runnerAs = (persona: Option.Option<string>) =>
  Layer.unwrap(
    Effect.map(repoWithTokenStep, (repo) => StepRunnerLive(repo, DEFAULT_GATE, {}, persona)),
  ).pipe(Layer.provide(GitHubTokens.fixed("implicit-token")));

const token = StepRunner.use((runner) => runner.run("token", {}));

describe("steps as a persona", () => {
  effect("a shell step runs with its persona's token", () =>
    Effect.gen(function* () {
      expect(yield* token).toEqual({ token: "token-bob" });
    }).pipe(Effect.provide(runnerAs(Option.some("bob")))),
  );

  effect("the implicit persona's step inherits this process's environment, unchanged", () =>
    Effect.gen(function* () {
      const inherited = yield* token;
      expect(inherited).not.toEqual({ token: "token-bob" });
      expect(inherited).not.toEqual({ token: "implicit-token" });
    }).pipe(Effect.provide(runnerAs(Option.none()))),
  );
});
