import { type Json, printJson } from "@chernabog/core";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { effectAtHomeWith } from "../../../../../../test/effect-test.ts";
import { Exec } from "../../../../../platform/exec.ts";
import { Home } from "../../../../../platform/home.ts";
import { type AgentSession } from "./adapter.ts";
import { codexAdapter } from "./codex.ts";
import { rememberSession } from "./sessions.ts";

const effect = effectAtHomeWith(Exec.layer);

const THREAD = "019a5b2c-1d2e-7f30-9a41-b52c63d74e85";

// Lines as Codex writes them to a rollout file: `{timestamp, type, payload}`.
const line = (type: string, payload: Json) =>
  printJson({ timestamp: "2026-11-08T12:00:00.000Z", type, payload });

const meta = line("session_meta", { id: THREAD, cwd: "/work/tree" });

const turn = (model: string) => line("turn_context", { cwd: "/work/tree", model });

type Totals = {
  input: number;
  cached: number;
  cacheWrite?: number;
  output: number;
  reasoning: number;
};

// A token_count event: the thread's running totals, cumulative over every turn.
const tokenCount = (total: Totals) =>
  line("event_msg", {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: total.input,
        cached_input_tokens: total.cached,
        ...Option.match(Option.fromUndefinedOr(total.cacheWrite), {
          onNone: () => ({}),
          onSome: (written) => ({ cache_write_input_tokens: written }),
        }),
        output_tokens: total.output,
        reasoning_output_tokens: total.reasoning,
        total_tokens: total.input + total.output,
      },
      last_token_usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
      },
      model_context_window: 272000,
    },
    rate_limits: { primary: { used_percent: 5 }, secondary: { used_percent: 1 } },
  });

// A rate-limit-only update carries no info (Codex writes it as null).
const rateLimitsOnly =
  '{"timestamp":"2026-11-08T12:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{}}}';

// The account's CODEX_HOME, under the test's home, and the session it ran.
const codexHome = Home.use((home) => Effect.succeed(`${home.user}/codex-work`));

const sessionIn = (configDir: string): AgentSession => ({
  sessionId: "issue-7",
  cwd: "/work/tree",
  account: {
    name: "work",
    configDir: Option.some(configDir),
    expectedEmail: Option.none(),
    oauthTokenEnv: Option.none(),
    usageGate: "usage",
  },
});

const rolloutFile = (home: string) =>
  `${home}/sessions/2026/11/08/rollout-2026-11-08T12-00-00-${THREAD}.jsonl`;

const append = (file: string, lines: ReadonlyArray<string>) =>
  FileSystem.FileSystem.use((fs) =>
    fs
      .makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(file, `${lines.join("\n")}\n`, { flag: "a" }))),
  );

// The Codex adapter's reader; a test of an adapter without one fails here.
const usage = (session: AgentSession, cursor: Option.Option<string>) =>
  Option.getOrThrow(Option.fromUndefinedOr(codexAdapter.usage))(session, cursor);

const firstCall = [
  meta,
  turn("gpt-5.5-codex"),
  rateLimitsOnly,
  tokenCount({ input: 1000, cached: 600, cacheWrite: 100, output: 200, reasoning: 120 }),
  tokenCount({ input: 3000, cached: 2000, cacheWrite: 300, output: 500, reasoning: 300 }),
];

effect("two calls on one Codex thread each charge only what they added", () =>
  Effect.gen(function* () {
    const home = yield* codexHome;
    const session = sessionIn(home);
    yield* rememberSession("codex", session.sessionId, THREAD);
    yield* append(rolloutFile(home), firstCall);

    const first = yield* usage(session, Option.none());

    // Input leaves out what came from or went into the cache; reasoning is part of output.
    expect(first.records).toEqual([
      {
        model: "gpt-5.5-codex",
        input: Option.some(700),
        output: Option.some(500),
        cacheRead: Option.some(2000),
        cacheWrite: Option.some(300),
      },
    ]);

    // The resumed thread appends to the same file, and its totals carry on.
    yield* append(rolloutFile(home), [
      turn("gpt-5.5-codex"),
      tokenCount({ input: 5000, cached: 3500, cacheWrite: 400, output: 900, reasoning: 500 }),
      rateLimitsOnly,
      tokenCount({ input: 5000, cached: 3500, cacheWrite: 400, output: 900, reasoning: 500 }),
    ]);

    const second = yield* usage(session, Option.some(first.cursor));

    expect(second.records).toEqual([
      {
        model: "gpt-5.5-codex",
        input: Option.some(400),
        output: Option.some(400),
        cacheRead: Option.some(1500),
        cacheWrite: Option.some(100),
      },
    ]);

    // Nothing new since: nothing charged, and the cursor stays put.
    const third = yield* usage(session, Option.some(second.cursor));

    expect(third.records).toEqual([]);
    expect(third.cursor).toBe(second.cursor);
  }),
);

effect("a call that switches models charges each model what it spent", () =>
  Effect.gen(function* () {
    const home = yield* codexHome;
    const session = sessionIn(home);
    yield* rememberSession("codex", session.sessionId, THREAD);
    yield* append(rolloutFile(home), firstCall);
    const first = yield* usage(session, Option.none());

    yield* append(rolloutFile(home), [
      turn("gpt-5.5-codex-mini"),
      tokenCount({ input: 3500, cached: 2200, cacheWrite: 300, output: 550, reasoning: 300 }),
      turn("gpt-5.5-codex"),
      tokenCount({ input: 4000, cached: 2200, cacheWrite: 350, output: 650, reasoning: 350 }),
    ]);

    const second = yield* usage(session, Option.some(first.cursor));

    expect(second.records).toEqual([
      {
        model: "gpt-5.5-codex-mini",
        input: Option.some(300),
        output: Option.some(50),
        cacheRead: Option.some(200),
        cacheWrite: Option.some(0),
      },
      {
        model: "gpt-5.5-codex",
        input: Option.some(450),
        output: Option.some(100),
        cacheRead: Option.some(0),
        cacheWrite: Option.some(50),
      },
    ]);
  }),
);

effect("a Codex that doesn't log cache writes leaves that count out", () =>
  Effect.gen(function* () {
    const home = yield* codexHome;
    const session = sessionIn(home);
    yield* rememberSession("codex", session.sessionId, THREAD);

    yield* append(rolloutFile(home), [
      meta,
      turn("gpt-5-codex"),
      tokenCount({ input: 1000, cached: 600, output: 200, reasoning: 120 }),
    ]);

    const reading = yield* usage(session, Option.none());

    expect(reading.records).toEqual([
      {
        model: "gpt-5-codex",
        input: Option.some(400),
        output: Option.some(200),
        cacheRead: Option.some(600),
        cacheWrite: Option.none(),
      },
    ]);
  }),
);

effect("a session Codex never opened a thread for can't be read", () =>
  Effect.gen(function* () {
    const home = yield* codexHome;
    const failed = yield* Effect.flip(usage(sessionIn(home), Option.none()));

    expect(failed.message).toContain("no Codex thread");
  }),
);

effect("a thread whose session file is gone can't be read", () =>
  Effect.gen(function* () {
    const home = yield* codexHome;
    const session = sessionIn(home);
    yield* rememberSession("codex", session.sessionId, THREAD);
    const failed = yield* Effect.flip(usage(session, Option.none()));

    expect(failed.message).toContain(THREAD);
  }),
);
