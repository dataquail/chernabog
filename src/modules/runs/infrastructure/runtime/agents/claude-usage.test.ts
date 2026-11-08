import { printJson } from "@chernabog/core";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

import { effectAtHomeWith } from "../../../../../../test/effect-test.ts";
import { settings } from "../../../../../../test/sdk-fakes.ts";
import { Exec } from "../../../../../platform/exec.ts";
import { Home } from "../../../../../platform/home.ts";
import { type ModelUsage } from "../../../domain/token-usage/model-usage.value-object.ts";
import { type AgentSession } from "./adapter.ts";
import { claudeAdapter } from "./claude.ts";
import { transcriptFile } from "./claude-events.ts";

const effectAtHome = effectAtHomeWith(Exec.layer);

const SESSION = "11111111-2222-3333-4444-555555555555";

type Counts = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
};

// One transcript line of an assistant message, as Claude writes it.
const assistant = (id: string, model: string, counts: Counts) =>
  `${printJson({
    type: "assistant",
    sessionId: SESSION,
    message: {
      id,
      model,
      role: "assistant",
      content: [{ type: "text", text: "working" }],
      usage: {
        input_tokens: counts.input,
        output_tokens: counts.output,
        cache_read_input_tokens: counts.cacheRead,
        cache_creation_input_tokens: counts.cacheWrite,
      },
    },
  })}\n`;

const user = `${printJson({ type: "user", message: { role: "user", content: "go" } })}\n`;

const counts = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

const usageOf = (model: string, spent: Counts): ModelUsage => ({
  model,
  input: Option.some(spent.input),
  output: Option.some(spent.output),
  cacheRead: Option.some(spent.cacheRead),
  cacheWrite: Option.some(spent.cacheWrite),
});

const byModel = (records: ReadonlyArray<ModelUsage>) =>
  Arr.sort(
    records,
    Order.mapInput(Order.String, (record: ModelUsage) => record.model),
  );

const usage = (session: AgentSession, cursor: Option.Option<string>) =>
  Option.match(Option.fromUndefinedOr(claudeAdapter.usage), {
    onNone: () => Effect.die("the claude adapter has no usage reader"),
    onSome: (reads) => reads(session, cursor),
  });

// A worktree to run in, and where Claude keeps its session's transcript and
// its subagents' under the default config dir (~/.claude).
const sessionAt = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* Home;
  const cwd = `${home.root}/worktree`;
  yield* fs.makeDirectory(cwd, { recursive: true });

  const session: AgentSession = { sessionId: SESSION, cwd, account: settings.account };
  const main = yield* transcriptFile(session, `${home.user}/.claude`);
  const subagents = `${main.slice(0, -".jsonl".length)}/subagents`;
  yield* fs.makeDirectory(subagents, { recursive: true });

  const append = (file: string, text: string) =>
    fs.writeFileString(file, text, { flag: "a" }).pipe(Effect.orDie);

  return {
    session,
    appendMain: (text: string) => append(main, text),
    appendSubagent: (name: string, text: string) => append(`${subagents}/${name}.jsonl`, text),
  };
});

describe("the Claude adapter reads what a session spent from its transcripts", () => {
  effectAtHome("a message written as several lines counts once, summed per model", () =>
    Effect.gen(function* () {
      const { appendMain, session } = yield* sessionAt;

      yield* appendMain(
        [
          user,
          assistant("msg_1", "claude-opus-4-5", counts(10, 5, 1000, 200)),
          assistant("msg_1", "claude-opus-4-5", counts(10, 5, 1000, 200)),
          assistant("msg_1", "claude-opus-4-5", counts(10, 5, 1000, 200)),
          user,
          assistant("msg_2", "claude-opus-4-5", counts(3, 7, 1200, 50)),
          assistant("msg_2", "claude-opus-4-5", counts(3, 7, 1200, 50)),
          assistant("msg_3", "claude-haiku-4-5", counts(40, 2, 0, 0)),
        ].join(""),
      );

      const reading = yield* usage(session, Option.none());

      expect(byModel(reading.records)).toEqual([
        usageOf("claude-haiku-4-5", counts(40, 2, 0, 0)),
        usageOf("claude-opus-4-5", counts(13, 12, 2200, 250)),
      ]);
    }),
  );

  effectAtHome("subagents' messages count too, under their own models", () =>
    Effect.gen(function* () {
      const { appendMain, appendSubagent, session } = yield* sessionAt;

      yield* appendMain(assistant("msg_1", "claude-opus-4-5", counts(10, 5, 1000, 200)));

      yield* appendSubagent(
        "agent-a1",
        [
          assistant("msg_s1", "claude-haiku-4-5", counts(20, 4, 300, 10)),
          assistant("msg_s1", "claude-haiku-4-5", counts(20, 4, 300, 10)),
        ].join(""),
      );

      yield* appendSubagent("agent-b2", assistant("msg_s2", "claude-opus-4-5", counts(1, 1, 1, 1)));

      const reading = yield* usage(session, Option.none());

      expect(byModel(reading.records)).toEqual([
        usageOf("claude-haiku-4-5", counts(20, 4, 300, 10)),
        usageOf("claude-opus-4-5", counts(11, 6, 1001, 201)),
      ]);
    }),
  );

  effectAtHome("a second call on the session charges only the messages it added", () =>
    Effect.gen(function* () {
      const { appendMain, appendSubagent, session } = yield* sessionAt;

      yield* appendMain(
        [
          assistant("msg_1", "claude-opus-4-5", counts(10, 5, 1000, 200)),
          assistant("msg_2", "claude-opus-4-5", counts(3, 7, 1200, 50)),
        ].join(""),
      );

      yield* appendSubagent(
        "agent-a1",
        assistant("msg_s1", "claude-haiku-4-5", counts(20, 4, 300, 10)),
      );

      const first = yield* usage(session, Option.none());

      // The second call resumes the session: a line of msg_2 written again,
      // new messages, and a new subagent.
      yield* appendMain(
        [
          user,
          assistant("msg_2", "claude-opus-4-5", counts(3, 7, 1200, 50)),
          assistant("msg_4", "claude-opus-4-5", counts(1, 2, 3000, 4)),
        ].join(""),
      );

      yield* appendSubagent(
        "agent-a1",
        assistant("msg_s1", "claude-haiku-4-5", counts(20, 4, 300, 10)),
      );
      yield* appendSubagent(
        "agent-c3",
        assistant("msg_s3", "claude-haiku-4-5", counts(5, 5, 5, 5)),
      );

      const second = yield* usage(session, Option.some(first.cursor));

      expect(byModel(second.records)).toEqual([
        usageOf("claude-haiku-4-5", counts(5, 5, 5, 5)),
        usageOf("claude-opus-4-5", counts(1, 2, 3000, 4)),
      ]);

      const third = yield* usage(session, Option.some(second.cursor));

      expect(third.records).toEqual([]);
    }),
  );

  effectAtHome("a line still being written waits for the next read", () =>
    Effect.gen(function* () {
      const { appendMain, session } = yield* sessionAt;
      const line = assistant("msg_1", "claude-opus-4-5", counts(10, 5, 1000, 200));

      yield* appendMain(line.slice(0, 40));

      const first = yield* usage(session, Option.none());

      expect(first.records).toEqual([]);

      yield* appendMain(line.slice(40));

      const second = yield* usage(session, Option.some(first.cursor));

      expect(second.records).toEqual([usageOf("claude-opus-4-5", counts(10, 5, 1000, 200))]);
    }),
  );

  effectAtHome("a session with no transcript yet spent nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* Home;
      const cwd = `${home.root}/elsewhere`;
      yield* fs.makeDirectory(cwd, { recursive: true });

      const reading = yield* usage(
        { sessionId: SESSION, cwd, account: settings.account },
        Option.none(),
      );

      expect(reading.records).toEqual([]);
    }),
  );
});
