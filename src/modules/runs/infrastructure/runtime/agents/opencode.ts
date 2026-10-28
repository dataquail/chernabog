// opencode, headless: `opencode run --format json`. It has no structured
// output, so the schema goes into the prompt and the answer is the last JSON
// object of its final message. Its session ids are its own, recorded the
// moment it reports them.

import { AgentError, printJson } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type Adapter,
  agentEnvironment,
  answerFrom,
  promptFor,
  withAnswerFormat,
} from "./adapter.ts";
import { clip, runAgentProcess } from "./process.ts";
import { knownSession, rememberSession } from "./sessions.ts";

const Part = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  messageID: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.Struct({ input: Schema.optionalKey(Schema.Json) })),
});

export const OpencodeEvent = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    sessionID: Schema.optionalKey(Schema.String),
    part: Schema.optionalKey(Part),
    error: Schema.optionalKey(Schema.Json),
  }),
);

export type OpencodeEvent = typeof OpencodeEvent.Type;

export const describeOpencodeEvent = (event: OpencodeEvent) => {
  const part = Option.fromUndefinedOr(event.part);

  const text = Option.flatMap(part, (found) => Option.fromUndefinedOr(found.text)).pipe(
    Option.filter((found) => found.trim().length > 0),
  );

  if (event.type === "text" && Option.isSome(text)) {
    return Option.some(clip(text.value.trim().replace(/\s+/g, " ")));
  }

  if (event.type === "tool_use" || Option.exists(part, (found) => found.type === "tool")) {
    const tool = Option.getOrElse(
      Option.flatMap(part, (found) => Option.fromUndefinedOr(found.tool)),
      () => "tool",
    );

    const input = Option.getOrElse(
      Option.flatMap(part, (found) => Option.fromUndefinedOr(found.state?.input)),
      () => ({}),
    );

    return Option.some(`${tool}(${clip(printJson(input), 120)})`);
  }

  if (event.type === "error") {
    return Option.some(`opencode: ${clip(printJson(event.error ?? "error"))}`);
  }

  return Option.none<string>();
};

export const opencodeArgs = (session: Option.Option<string>, extra: ReadonlyArray<string>) => [
  "run",
  "--format",
  "json",
  ...Option.match(session, { onNone: () => [], onSome: (id) => ["--session", id] }),
  ...extra,
];

// The text of the latest message: an answer spans the text parts of one message.
type Message = { readonly id: Option.Option<string>; readonly text: string };

const sameMessage = Option.makeEquivalence<string>((a, b) => a === b);

const appendText = (message: Message, event: OpencodeEvent): Message => {
  const text = Option.flatMap(Option.fromUndefinedOr(event.part), (part) =>
    Option.fromUndefinedOr(part.text),
  );

  if (event.type !== "text" || Option.isNone(text)) {
    return message;
  }

  const id = Option.flatMap(Option.fromUndefinedOr(event.part), (part) =>
    Option.fromUndefinedOr(part.messageID),
  );

  if (sameMessage(id, message.id)) {
    return { id, text: `${message.text}${text.value}` };
  }

  return { id, text: text.value };
};

// opencode's `--auto` approves every permission not explicitly denied; it is left
// to the person to opt into through machine config (agents.opencode.args).
export const opencodeAdapter = (extraArgs: ReadonlyArray<string>): Adapter => ({
  name: "opencode",
  run: (request, context) =>
    Effect.gen(function* () {
      const known = yield* knownSession("opencode", request.sessionId);

      yield* context.log(
        Option.match(known, {
          onNone: () => `opencode: starting a session for ${request.sessionId}`,
          onSome: (id) => `opencode: resuming session ${id} for ${request.sessionId}`,
        }),
      );

      let current = known;
      let failure = Option.none<string>();
      let message: Message = { id: Option.none(), text: "" };

      const prompt = withAnswerFormat(
        promptFor(request, Option.isSome(known)),
        request.outputSchema,
      );

      const onLine = (line: string) =>
        Option.match(Schema.decodeOption(OpencodeEvent)(line), {
          onNone: () => context.log(clip(line)),
          onSome: (event) =>
            Effect.gen(function* () {
              const reported = Option.fromUndefinedOr(event.sessionID);

              if (Option.isNone(current) && Option.isSome(reported)) {
                current = reported;
                yield* rememberSession("opencode", request.sessionId, reported.value);
              }

              if (event.type === "error") {
                failure = Option.some(printJson(event.error ?? "error"));
              }

              message = appendText(message, event);
              yield* Option.match(describeOpencodeEvent(event), {
                onNone: () => Effect.void,
                onSome: context.log,
              });
            }),
        });

      const args = [...opencodeArgs(known, extraArgs), prompt];

      const finished = yield* runAgentProcess(
        {
          command: "opencode",
          args,
          cwd: request.cwd,
          env: agentEnvironment(context, {}, []),
          stdin: "",
        },
        onLine,
      );

      if (finished.exitCode !== 0 || Option.isSome(failure)) {
        return yield* new AgentError({
          message: `opencode exited ${finished.exitCode}: ${clip(
            Option.getOrElse(failure, () => finished.stderr),
            2000,
          )}`,
        });
      }

      return {
        sessionId: Option.getOrElse(current, () => request.sessionId),
        output: answerFrom(message.text, request.outputSchema),
        costUsd: Option.none<number>(),
      };
    }),
});
