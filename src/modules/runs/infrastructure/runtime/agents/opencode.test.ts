import { type AgentRequest, HEADLESS } from "@chernabog/core";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { effectAtHomeWith } from "../../../../../../test/effect-test.ts";
import { settings } from "../../../../../../test/sdk-fakes.ts";
import { Exec } from "../../../../../platform/exec.ts";
import { type AdapterContext, type AgentSession } from "./adapter.ts";
import { opencodeAdapter, opencodeModel } from "./opencode.ts";

const effect = effectAtHomeWith(Exec.layer);

type Fake = { readonly bin: string; readonly fixtures: string };

// An `opencode` on PATH that prints the fixture `OPENCODE_FIXTURE` names, as
// `opencode run --format json` would, and exits with `OPENCODE_EXIT`.
const fakeOpencode = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bin = yield* fs.makeTempDirectoryScoped({ prefix: "fake-opencode-" });
  const script = path.join(bin, "opencode");

  const fixtures = yield* path.fromFileUrl(
    new URL("../../../../../../fixtures/opencode", import.meta.url),
  );

  yield* fs.writeFileString(
    script,
    '#!/bin/sh\ncat "$OPENCODE_FIXTURE"\nexit "${OPENCODE_EXIT:-0}"\n',
  );
  yield* fs.chmod(script, 0o755);

  return { bin, fixtures } satisfies Fake;
});

const contextFor = (fake: Fake, fixture: string, exit = 0): AdapterContext => ({
  account: settings.account,
  host: { PATH: `${fake.bin}:/usr/bin:/bin` },
  env: { OPENCODE_FIXTURE: `${fake.fixtures}/${fixture}`, OPENCODE_EXIT: String(exit) },
  launcher: HEADLESS,
  log: () => Effect.void,
});

const request = (cwd: string): AgentRequest => ({
  cwd,
  prompt: "implement the issue",
  sessionId: "issue-408",
  resumePrompt: Option.none(),
  outputSchema: Option.none(),
  adapter: Option.some("opencode"),
});

const sessionIn = (cwd: string): AgentSession => ({
  sessionId: "issue-408",
  cwd,
  account: settings.account,
});

// Sonnet's two steps: a tool call, then the answer. Reasoning is output.
const sonnet = {
  model: "anthropic/claude-sonnet-4-5",
  input: Option.some(1500),
  output: Option.some(130),
  cacheRead: Option.some(32400),
  cacheWrite: Option.some(2400),
};

const gpt = {
  model: "openai/gpt-5",
  input: Option.some(5000),
  output: Option.some(900),
  cacheRead: Option.some(3000),
  cacheWrite: Option.some(0),
};

const usageOf = (adapter: ReturnType<typeof opencodeAdapter>) =>
  Option.getOrThrow(Option.fromUndefinedOr(adapter.usage));

describe("opencode reports what each call spent", () => {
  effect("a call's steps add up to one record for the model it ran on", () =>
    Effect.gen(function* () {
      const fake = yield* fakeOpencode;
      const adapter = opencodeAdapter(["--model", "anthropic/claude-sonnet-4-5"]);

      yield* adapter.run(request("/tmp"), contextFor(fake, "sonnet-two-steps.jsonl"));

      const reading = yield* usageOf(adapter)(sessionIn("/tmp"), Option.none());

      expect(reading).toEqual({ records: [sonnet], cursor: "prt_b3" });
    }),
  );

  effect("each call on a resumed session charges only what it added", () =>
    Effect.gen(function* () {
      const fake = yield* fakeOpencode;
      const adapter = opencodeAdapter(["-m", "openai/gpt-5#high"]);

      yield* adapter.run(request("/tmp"), contextFor(fake, "sonnet-two-steps.jsonl"));
      yield* usageOf(adapter)(sessionIn("/tmp"), Option.none());

      yield* adapter.run(request("/tmp"), contextFor(fake, "gpt-one-step.jsonl"));

      const reading = yield* usageOf(adapter)(sessionIn("/tmp"), Option.some("prt_b3"));

      expect(reading).toEqual({ records: [gpt], cursor: "prt_c4" });
    }),
  );

  effect("a call's usage is read once", () =>
    Effect.gen(function* () {
      const fake = yield* fakeOpencode;
      const adapter = opencodeAdapter(["--model=openai/gpt-5"]);

      yield* adapter.run(request("/tmp"), contextFor(fake, "gpt-one-step.jsonl"));
      yield* usageOf(adapter)(sessionIn("/tmp"), Option.none());

      const again = yield* Effect.flip(usageOf(adapter)(sessionIn("/tmp"), Option.some("prt_c4")));

      expect(again.message).toContain("no token counts");
    }),
  );

  effect("a call that fails still reports the steps it finished", () =>
    Effect.gen(function* () {
      const fake = yield* fakeOpencode;
      const adapter = opencodeAdapter(["--model", "openai/gpt-5"]);

      const failed = yield* Effect.flip(
        adapter.run(request("/tmp"), contextFor(fake, "gpt-one-step.jsonl", 1)),
      );

      expect(failed.message).toContain("opencode exited 1");
      expect(yield* usageOf(adapter)(sessionIn("/tmp"), Option.none())).toEqual({
        records: [gpt],
        cursor: "prt_c4",
      });
    }),
  );

  effect("steps without token counts leave the call not reported", () =>
    Effect.gen(function* () {
      const fake = yield* fakeOpencode;
      const adapter = opencodeAdapter([]);

      yield* adapter.run(request("/tmp"), contextFor(fake, "no-tokens.jsonl"));

      const unread = yield* Effect.flip(usageOf(adapter)(sessionIn("/tmp"), Option.none()));

      expect(unread.message).toContain("no token counts");
    }),
  );
});

describe("the model a call runs on", () => {
  for (const [args, model] of [
    [["--model", "anthropic/claude-sonnet-4-5"], "anthropic/claude-sonnet-4-5"],
    [["-m", "openai/gpt-5#high"], "openai/gpt-5"],
    [["--model=openai/gpt-5", "--agent", "build"], "openai/gpt-5"],
    [["-m", "openai/gpt-5", "--model", "anthropic/claude-opus-4-1"], "anthropic/claude-opus-4-1"],
    [["--agent", "build"], "unknown"],
  ] as const) {
    effect(`${args.join(" ")} runs on ${model}`, () =>
      Effect.sync(() => {
        expect(opencodeModel(args)).toBe(model);
      }),
    );
  }
});
