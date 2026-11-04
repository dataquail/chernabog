// A step's process acts as the run's persona: it gets the persona's token in
// its environment, and nothing extra for the implicit persona.

import { CurrentActivity, RunLog, StepRunner } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { runLogWriting } from "../src/modules/runs/infrastructure/runtime/runlog.ts";
import { StepRunnerLive } from "../src/modules/runs/infrastructure/runtime/steps.ts";
import { GitHubTokens } from "../src/platform/github-auth.ts";
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

// A repo whose one step says something on stderr, which the run's log copies.
const repoWithChattyStep = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-step-runner-" });
  yield* fs.makeDirectory(`${path}/.chernabog/stages`, { recursive: true });
  yield* fs.writeFileString(
    `${path}/.chernabog/stages/chatty`,
    "#!/bin/sh\ncat >/dev/null\necho 'working on it' >&2\necho '{}'\n",
  );
  yield* fs.chmod(`${path}/.chernabog/stages/chatty`, 0o755);

  return { ...settings, path, configDir: `${path}/.chernabog` };
});

// Where the chatty repo's run log is written.
class ChattyLog extends Context.Service<ChattyLog, string>()("test/ChattyLog") {}

// The step runner over that repo, and a run log in it.
const chattyRunner = Layer.unwrap(
  Effect.map(repoWithChattyStep, (repo) =>
    Layer.mergeAll(
      StepRunnerLive(repo, DEFAULT_GATE, {}, Option.none()),
      Layer.effect(RunLog, runLogWriting(`${repo.path}/run.log`)),
      Layer.succeed(ChattyLog, `${repo.path}/run.log`),
    ),
  ),
).pipe(Layer.provide(GitHubTokens.fixed("implicit-token")));

describe("a step's output in the run's log", () => {
  effect("is tagged with the step it ran in, as every line written in an activity is", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      // As activity runs it: CurrentActivity names the step for what it calls.
      yield* Effect.provideService(
        StepRunner.use((runner) => runner.run("chatty", {})),
        CurrentActivity,
        Option.some("chatty#task-7"),
      );

      const lines = (yield* fs.readFileString(yield* ChattyLog)).trim().split("\n");

      expect(lines.map((line) => line.split("\t").slice(1))).toEqual([
        ["chatty#task-7", "chatty: working on it"],
      ]);
    }).pipe(Effect.provide(chattyRunner)),
  );
});
