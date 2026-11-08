// What a Claude Code session spent, read from the transcripts Claude already
// writes: the session's own, and each of its subagents'. Each assistant message
// carries its model and usage, but Claude writes one message as several lines
// that repeat both, so a message counts once, by its id. Starting Claude is
// none of this file's business: it only reads.
//
// The cursor holds, for each transcript file, how far it was read (whole lines
// only, so a line still being written waits for the next read) and the id of
// the last message read, whose further lines may come after that offset and
// were charged already. Each message is charged to exactly one call, across
// the calls and runs that share the session.

import { AgentError } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";

import { claudeHomeOf } from "../../../../../platform/agent-accounts.ts";
import { Home } from "../../../../../platform/home.ts";
import { type ModelUsage } from "../../../domain/token-usage/model-usage.value-object.ts";
import { type AgentSession } from "./adapter.ts";
import { transcriptFile } from "./claude-events.ts";

const Count = Schema.optionalKey(Schema.Finite);

const AssistantUsage = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("assistant"),
    message: Schema.Struct({
      id: Schema.String,
      model: Schema.String,
      usage: Schema.Struct({
        input_tokens: Count,
        output_tokens: Count,
        cache_read_input_tokens: Count,
        cache_creation_input_tokens: Count,
      }),
    }),
  }),
);

type AssistantUsage = typeof AssistantUsage.Type;

// Where one transcript file was read to, and the last message read in it
// (none before any).
const FilePosition = Schema.Struct({
  offset: Schema.Int,
  last: Schema.Array(Schema.String),
});

type FilePosition = typeof FilePosition.Type;

// Each transcript file, named relative to the session's transcript ("main",
// "subagents/<file>"), so the cursor doesn't depend on where the config dir is.
const ClaudeCursor = Schema.fromJsonString(
  Schema.Struct({ files: Schema.Record(Schema.String, FilePosition) }),
);

const START: FilePosition = { offset: 0, last: [] };

// Claude writes these itself, for an error it shows, and they cost nothing.
const SYNTHETIC = "<synthetic>";

type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number };

const failed = (what: string) => (cause: unknown) =>
  new AgentError({ message: `claude: couldn't read ${what}: ${String(cause)}` });

const cursorOf = (cursor: Option.Option<string>) =>
  Option.match(cursor, {
    onNone: () => Effect.succeed(new Map<string, FilePosition>()),
    onSome: (text) =>
      Schema.decodeEffect(ClaudeCursor)(text).pipe(
        Effect.map((decoded) => new Map(Object.entries(decoded.files))),
        Effect.mapError(failed(`the usage cursor ${text}`)),
      ),
  });

// The whole lines written to `file` since `from`, and where they end. A file
// shorter than the offset was rewritten, and is read again from its start.
const newLines = (file: string, from: FilePosition) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const size = Number((yield* fs.stat(file)).size);

    const start = Option.liftPredicate(from, () => size >= from.offset).pipe(
      Option.getOrElse(() => START),
    );

    if (size === start.offset) {
      return { lines: [], position: start };
    }

    const bytes = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(file);
        yield* handle.seek(BigInt(start.offset), "start");

        return yield* handle.readAlloc(size - start.offset);
      }),
    );

    const read = Option.getOrElse(bytes, () => new Uint8Array());
    const whole = read.lastIndexOf(0x0a) + 1;
    const lines = new TextDecoder().decode(read.subarray(0, whole)).split("\n").slice(0, -1);

    return { lines, position: { ...start, offset: start.offset + whole } };
  }).pipe(Effect.mapError(failed(file)));

// The messages first seen in `lines`, each once, and the last message read.
const messagesIn = (lines: ReadonlyArray<string>, from: FilePosition) => {
  const seen = new Set(from.last);
  const messages: Array<AssistantUsage["message"]> = [];
  let last = from.last;

  for (const line of lines) {
    const decoded = Schema.decodeOption(AssistantUsage)(line);

    if (Option.isSome(decoded)) {
      const message = decoded.value.message;
      last = [message.id];

      if (!seen.has(message.id)) {
        seen.add(message.id);
        messages.push(message);
      }
    }
  }

  return { last, messages };
};

const add = (totals: Map<string, Totals>, message: AssistantUsage["message"]) => {
  if (message.model === SYNTHETIC) {
    return;
  }

  const sum = totals.get(message.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const usage = message.usage;

  totals.set(message.model, {
    input: sum.input + (usage.input_tokens ?? 0),
    output: sum.output + (usage.output_tokens ?? 0),
    cacheRead: sum.cacheRead + (usage.cache_read_input_tokens ?? 0),
    cacheWrite: sum.cacheWrite + (usage.cache_creation_input_tokens ?? 0),
  });
};

// The session's transcript, and its subagents' that exist, each by its name in the cursor.
const transcriptsOf = (session: AgentSession) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;
    const main = yield* transcriptFile(session, claudeHomeOf(session.account, home.user));
    const subagents = `${main.slice(0, -".jsonl".length)}/subagents`;

    const listed = yield* fs.readDirectory(subagents).pipe(Effect.orElseSucceed(() => []));

    const named = Arr.sort(
      listed.filter((name) => name.endsWith(".jsonl")),
      Order.String,
    );

    const files = [
      { name: "main", path: main },
      ...named.map((name) => ({ name: `subagents/${name}`, path: `${subagents}/${name}` })),
    ];

    return yield* Effect.filter(files, (file) => fs.exists(file.path));
  }).pipe(Effect.mapError(failed(`the transcripts of session ${session.sessionId}`)));

export const claudeUsage = (session: AgentSession, cursor: Option.Option<string>) =>
  Effect.gen(function* () {
    const positions = yield* cursorOf(cursor);
    const totals = new Map<string, Totals>();

    for (const file of yield* transcriptsOf(session)) {
      const from = positions.get(file.name) ?? START;
      const read = yield* newLines(file.path, from);
      const { last, messages } = messagesIn(read.lines, read.position);

      for (const message of messages) {
        add(totals, message);
      }

      positions.set(file.name, { offset: read.position.offset, last });
    }

    const records: ReadonlyArray<ModelUsage> = [...totals].map(([model, sum]) => ({
      model,
      input: Option.some(sum.input),
      output: Option.some(sum.output),
      cacheRead: Option.some(sum.cacheRead),
      cacheWrite: Option.some(sum.cacheWrite),
    }));

    const next = yield* Schema.encodeEffect(ClaudeCursor)({
      files: Object.fromEntries(positions),
    }).pipe(Effect.mapError(failed("the usage cursor")));

    return { records, cursor: next };
  });
