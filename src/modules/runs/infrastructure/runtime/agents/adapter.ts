// What every agent adapter has in common: how it is called, the services it
// runs with, and the answer formats an agent without structured output needs.

import {
  type Account,
  type AgentError,
  type AgentRequest,
  type AgentResult,
  type Json,
  parseJson,
  printJson,
  type ResolvedLauncher,
} from "@chernabog/core";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { type Environment, withVariables } from "../../../../../platform/environment.ts";
import type { Exec } from "../../../../../platform/exec.ts";
import type { Home } from "../../../../../platform/home.ts";
import { type TokenUsageReading } from "../../../domain/token-usage/model-usage.value-object.ts";

export type AdapterServices =
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Home | Exec;

export type AdapterContext = {
  readonly account: Account;
  // This process's environment, and what the repo adds to it (its pinned Node).
  readonly host: Environment;
  readonly env: Environment;
  // Where an interactive session runs; headless for none. Only Claude has an interactive mode so far.
  readonly launcher: ResolvedLauncher;
  readonly log: (line: string) => Effect.Effect<void>;
};

// What an adapter needs to find a session's own records: our id for it, the
// worktree it ran in, and the account it ran under.
export type AgentSession = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly account: Account;
};

export type Adapter = {
  readonly name: string;
  // Answers every call, whatever adapter it asks for: a rehearsal's.
  readonly exclusive?: boolean;
  run(
    request: AgentRequest,
    context: AdapterContext,
  ): Effect.Effect<AgentResult, AgentError, AdapterServices>;
  // What a session spent since `cursor` (none for a session never read), per
  // model, read from the agent's own records, and the cursor to read on from.
  // The cursor's form is the adapter's own. An adapter without it records
  // each call as not reported.
  readonly usage?: (
    session: AgentSession,
    cursor: Option.Option<string>,
  ) => Effect.Effect<TokenUsageReading, AgentError, AdapterServices>;
};

// API keys would bill per token; Chernabog only spends subscription capacity.
export const API_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
];

// For agents with no structured output: the schema goes into the prompt, and
// the answer is the last JSON object in the agent's final message.
export const withAnswerFormat = (prompt: string, schema: Option.Option<Json>) =>
  Option.match(schema, {
    onNone: () => prompt,
    onSome: (json) =>
      `${prompt}\n\n## Answer format\n\nEnd your final message with one JSON object, alone on its last lines, matching this JSON Schema:\n\n\`\`\`json\n${printJson(json)}\n\`\`\`\n`,
  });

// The last `{…}` in the text that parses as JSON.
export const lastJsonObject = (text: string): Option.Option<Json> => {
  for (let end = text.lastIndexOf("}"); end >= 0; end = text.lastIndexOf("}", end - 1)) {
    for (
      let start = text.lastIndexOf("{", end);
      start >= 0;
      start = text.lastIndexOf("{", start - 1)
    ) {
      const parsed = parseJson(text.slice(start, end + 1));

      if (Option.isSome(parsed)) {
        return parsed;
      }
    }
  }

  return Option.none();
};

// The agent's final message as its answer: JSON when a schema asked for it, else the text itself.
export const answerFrom = (text: string, schema: Option.Option<Json>): Json => {
  if (Option.isNone(schema)) {
    return text;
  }

  return Option.getOrElse(
    Option.orElse(parseJson(text), () => lastJsonObject(text)),
    () => text,
  );
};

export const promptFor = (request: AgentRequest, resuming: boolean) => {
  if (resuming) {
    return Option.getOrElse(request.resumePrompt, () => request.prompt);
  }

  return request.prompt;
};

export const agentEnvironment = (
  context: AdapterContext,
  set: Environment,
  remove: ReadonlyArray<string>,
) => withVariables({ ...context.host, ...context.env }, set, [...API_KEYS, ...remove]);

export const resumingOrStarting = (resuming: boolean) => {
  if (resuming) {
    return "resuming";
  }

  return "starting";
};
