// What a Codex thread spent, from its rollout file under
// $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl. Codex writes a
// token_count event after each model response whose info.total_token_usage is
// the thread's running total (a resumed thread restores it from the file and
// carries on), and a turn_context line, with the model, at each turn. So the
// cursor is the last total read: a call charges what the totals grew by since,
// to the model of the turn each growth came in.
//
// Codex's counts are the Responses API's: input_tokens includes the cached and
// cache-write tokens, and output_tokens includes the reasoning tokens.

import { AgentError } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";

import { codexHomeOf } from "../../../../../platform/agent-accounts.ts";
import { Home } from "../../../../../platform/home.ts";
import {
  type ModelUsage,
  type TokenUsageReading,
} from "../../../domain/token-usage/model-usage.value-object.ts";
import { type AgentSession } from "./adapter.ts";
import { knownSession } from "./sessions.ts";

// A total as Codex logs it, and as the cursor keeps it. Codex before
// cache_write_input_tokens leaves it out.
const Totals = Schema.Struct({
  input_tokens: Schema.Finite,
  cached_input_tokens: Schema.Finite,
  cache_write_input_tokens: Schema.optionalKey(Schema.Finite),
  output_tokens: Schema.Finite,
});

type Totals = typeof Totals.Type;

const Cursor = Schema.fromJsonString(Totals);

const TurnContext = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("turn_context"),
    payload: Schema.Struct({ model: Schema.String }),
  }),
);

// A token_count event with totals; one that only updates rate limits has none.
const TokenCount = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("event_msg"),
    payload: Schema.Struct({
      type: Schema.Literal("token_count"),
      info: Schema.Struct({ total_token_usage: Totals }),
    }),
  }),
);

const NONE: Totals = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };

const cacheWrites = (totals: Totals) => totals.cache_write_input_tokens ?? 0;

// What `next` adds to `seen`, each count on its own; a count never goes back.
const growth = (seen: Totals, next: Totals): Totals => ({
  input_tokens: Math.max(0, next.input_tokens - seen.input_tokens),
  cached_input_tokens: Math.max(0, next.cached_input_tokens - seen.cached_input_tokens),
  ...Option.match(Option.fromUndefinedOr(next.cache_write_input_tokens), {
    onNone: () => ({}),
    onSome: (written) => ({ cache_write_input_tokens: Math.max(0, written - cacheWrites(seen)) }),
  }),
  output_tokens: Math.max(0, next.output_tokens - seen.output_tokens),
});

const highest = (seen: Totals, next: Totals): Totals => ({
  input_tokens: Math.max(seen.input_tokens, next.input_tokens),
  cached_input_tokens: Math.max(seen.cached_input_tokens, next.cached_input_tokens),
  ...Option.match(
    Option.orElse(Option.fromUndefinedOr(next.cache_write_input_tokens), () =>
      Option.fromUndefinedOr(seen.cache_write_input_tokens),
    ),
    {
      onNone: () => ({}),
      onSome: () => ({ cache_write_input_tokens: Math.max(cacheWrites(seen), cacheWrites(next)) }),
    },
  ),
  output_tokens: Math.max(seen.output_tokens, next.output_tokens),
});

const sum = (a: Totals, b: Totals): Totals => ({
  input_tokens: a.input_tokens + b.input_tokens,
  cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
  ...Option.match(
    Option.orElse(Option.fromUndefinedOr(a.cache_write_input_tokens), () =>
      Option.fromUndefinedOr(b.cache_write_input_tokens),
    ),
    {
      onNone: () => ({}),
      onSome: () => ({ cache_write_input_tokens: cacheWrites(a) + cacheWrites(b) }),
    },
  ),
  output_tokens: a.output_tokens + b.output_tokens,
});

const isEmpty = (totals: Totals) =>
  totals.input_tokens === 0 &&
  totals.cached_input_tokens === 0 &&
  cacheWrites(totals) === 0 &&
  totals.output_tokens === 0;

// Codex's counts as the four: input is what came neither from the cache nor
// went into it, and output already holds the reasoning tokens
// (reasoning_output_tokens is a part of output_tokens, so it isn't added).
const asModelUsage = (model: string, spent: Totals): ModelUsage => ({
  model,
  input: Option.some(
    Math.max(0, spent.input_tokens - spent.cached_input_tokens - cacheWrites(spent)),
  ),
  output: Option.some(spent.output_tokens),
  cacheRead: Option.some(spent.cached_input_tokens),
  cacheWrite: Option.fromUndefinedOr(spent.cache_write_input_tokens),
});

// The model a token_count's growth is charged to before any turn_context names one.
const UNKNOWN_MODEL = "unknown";

// What a thread's lines added since `cursor`: each model's usage, and the highest totals seen.
type CodexSpend = { readonly records: ReadonlyArray<ModelUsage>; readonly seen: Totals };

const codexTokenUsage = (lines: ReadonlyArray<string>, cursor: Totals): CodexSpend => {
  const spent = new Map<string, Totals>();
  let model = UNKNOWN_MODEL;
  let seen = cursor;

  for (const line of lines) {
    const turn = Schema.decodeOption(TurnContext)(line);

    if (Option.isSome(turn)) {
      model = turn.value.payload.model;
    }

    const count = Schema.decodeOption(TokenCount)(line);

    if (Option.isSome(count)) {
      const total = count.value.payload.info.total_token_usage;
      const grown = growth(seen, total);
      seen = highest(seen, total);

      if (!isEmpty(grown)) {
        spent.set(model, sum(spent.get(model) ?? NONE, grown));
      }
    }
  }

  return {
    records: Array.from(spent, ([name, totals]) => asModelUsage(name, totals)),
    seen,
  };
};

const isThreadFile = (thread: string) => (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);

  // A reverted thread's files add `_<rollout id>` after the thread's.
  return (
    name.startsWith("rollout-") &&
    name.endsWith(".jsonl") &&
    (name.endsWith(`-${thread}.jsonl`) || name.includes(`-${thread}_`))
  );
};

// The rollout files of `thread`, oldest first: their paths start with the date and time.
const threadFiles = (sessions: string, thread: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    if (!(yield* fs.exists(sessions))) {
      return [];
    }

    return Arr.sort(
      (yield* fs.readDirectory(sessions, { recursive: true })).filter(isThreadFile(thread)),
      Order.String,
    ).map((file) => `${sessions}/${file}`);
  });

const fail = (message: string) =>
  Effect.fail(new AgentError({ message: `codex usage: ${message}` }));

export const readCodexTokenUsage = (session: AgentSession, cursor: Option.Option<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const thread = yield* knownSession("codex", session.sessionId);

    if (Option.isNone(thread)) {
      return yield* fail(`no Codex thread is known for ${session.sessionId}`);
    }

    const from = yield* Option.match(cursor, {
      onNone: () => Effect.succeed(NONE),
      onSome: (text) =>
        Option.match(Schema.decodeOption(Cursor)(text), {
          onNone: () => fail(`the cursor ${text} isn't a Codex total`),
          onSome: Effect.succeed,
        }),
    });

    const sessions = `${codexHomeOf(session.account, (yield* Home).user)}/sessions`;
    const files = yield* threadFiles(sessions, thread.value);

    if (files.length === 0) {
      return yield* fail(`no session file for thread ${thread.value} under ${sessions}`);
    }

    const texts = yield* Effect.forEach(files, (file) => fs.readFileString(file));
    const lines = texts.flatMap((text) => text.split("\n"));

    const read = codexTokenUsage(lines, from);

    const reading: TokenUsageReading = {
      records: read.records,
      cursor: yield* Schema.encodeEffect(Cursor)(read.seen),
    };

    return reading;
  }).pipe(
    Effect.catchTags({
      PlatformError: (error) => fail(error.message),
      SchemaError: (error) => fail(error.message),
    }),
  );
