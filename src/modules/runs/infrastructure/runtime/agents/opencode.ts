// opencode, headless: `opencode run --format json`. It has no structured
// output, so the schema goes into the prompt and the answer is the last JSON
// object of its final message. Its session ids are its own, recorded the
// moment it reports them.
//
// What a call spent comes from the same events: each `step_finish` carries
// its step's tokens (input, output, reasoning, cache read and write), but no
// event names the model, so a call is charged to the model its args choose.
// A run prints only the steps of the turn it sends, so a resumed session's
// earlier calls are never counted again.

import { AgentError, printJson } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type ModelUsage } from "../../../domain/token-usage/model-usage.value-object.ts";
import {
  type Adapter,
  agentEnvironment,
  answerFrom,
  promptFor,
  withAnswerFormat,
} from "./adapter.ts";
import { clip, runAgentProcess } from "./process.ts";
import { knownSession, rememberSession } from "./sessions.ts";

// A step's tokens, as opencode counts them: input without the cache, and
// reasoning apart from the output it is billed as.
const Tokens = Schema.Struct({
  input: Schema.optionalKey(Schema.Finite),
  output: Schema.optionalKey(Schema.Finite),
  reasoning: Schema.optionalKey(Schema.Finite),
  cache: Schema.optionalKey(
    Schema.Struct({
      read: Schema.optionalKey(Schema.Finite),
      write: Schema.optionalKey(Schema.Finite),
    }),
  ),
});

const Part = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  messageID: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.Struct({ input: Schema.optionalKey(Schema.Json) })),
  tokens: Schema.optionalKey(Tokens),
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

// The model a call runs on: the last `--model`/`-m` its args give, without
// its `#variant`. Without one, opencode picks from its own config, which it
// doesn't print.
export const opencodeModel = (args: ReadonlyArray<string>) => {
  const named = args.flatMap((arg, index) => {
    if (arg.startsWith("--model=")) {
      return [arg.slice("--model=".length)];
    }

    if (arg === "--model" || arg === "-m") {
      return Option.toArray(Option.fromUndefinedOr(args[index + 1]));
    }

    return [];
  });

  return Option.match(Option.fromUndefinedOr(named.at(-1)), {
    onNone: () => "unknown",
    onSome: (model) => model.replace(/#.*$/, ""),
  });
};

// What a call's finished steps spent so far, and the last step counted.
type Spent = { readonly counts: Omit<ModelUsage, "model">; readonly last: string };

// The sum of the counts there are; none when neither is.
const plus = (a: Option.Option<number>, b: Option.Option<number>) =>
  Option.match(a, {
    onNone: () => b,
    onSome: (left) => Option.some(left + Option.getOrElse(b, () => 0)),
  });

// A finished step's counts; none for any other event, or one without tokens.
const stepCounts = (event: OpencodeEvent): Option.Option<Spent> => {
  const part = Option.fromUndefinedOr(event.part);
  const tokens = Option.flatMap(part, (found) => Option.fromUndefinedOr(found.tokens));

  if (event.type !== "step_finish" || Option.isNone(tokens)) {
    return Option.none();
  }

  const cache = Option.fromUndefinedOr(tokens.value.cache);

  return Option.some({
    counts: {
      input: Option.fromUndefinedOr(tokens.value.input),
      // Reasoning is billed as output.
      output: plus(
        Option.fromUndefinedOr(tokens.value.output),
        Option.fromUndefinedOr(tokens.value.reasoning),
      ),
      cacheRead: Option.flatMap(cache, (found) => Option.fromUndefinedOr(found.read)),
      cacheWrite: Option.flatMap(cache, (found) => Option.fromUndefinedOr(found.write)),
    },
    last: Option.getOrElse(
      Option.flatMap(part, (found) =>
        Option.orElse(Option.fromUndefinedOr(found.id), () =>
          Option.fromUndefinedOr(found.messageID),
        ),
      ),
      () => "step",
    ),
  });
};

const addSpent = (before: Option.Option<Spent>, step: Spent): Spent =>
  Option.match(before, {
    onNone: () => step,
    onSome: (far) => ({
      counts: {
        input: plus(far.counts.input, step.counts.input),
        output: plus(far.counts.output, step.counts.output),
        cacheRead: plus(far.counts.cacheRead, step.counts.cacheRead),
        cacheWrite: plus(far.counts.cacheWrite, step.counts.cacheWrite),
      },
      last: step.last,
    }),
  });

// opencode's `--auto` approves every permission not explicitly denied; it is left
// to the person to opt into through machine config (agents.opencode.args).
export const opencodeAdapter = (extraArgs: ReadonlyArray<string>): Adapter => {
  // What each session's latest call spent, by our session id, until it is read.
  const spent = new Map<string, Spent>();
  const model = opencodeModel(extraArgs);

  return {
    name: "opencode",
    run: (request, context) =>
      Effect.gen(function* () {
        const known = yield* knownSession("opencode", request.sessionId);

        // A call left unread (outside a run) is never charged to the next.
        spent.delete(request.sessionId);

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

                for (const step of Option.toArray(stepCounts(event))) {
                  spent.set(
                    request.sessionId,
                    addSpent(Option.fromUndefinedOr(spent.get(request.sessionId)), step),
                  );
                }

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
    // The call's steps, collected as it ran: its events are the only place
    // opencode reports them. The cursor is the last step counted.
    usage: (session) =>
      Option.match(Option.fromUndefinedOr(spent.get(session.sessionId)), {
        onNone: () =>
          Effect.fail(
            new AgentError({ message: "opencode: the call's steps reported no token counts" }),
          ),
        onSome: (found) =>
          Effect.sync(() => {
            spent.delete(session.sessionId);

            return { records: [{ model, ...found.counts }], cursor: found.last };
          }),
      }),
  };
};
