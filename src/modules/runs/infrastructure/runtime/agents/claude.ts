// Claude Code. Under a launcher (orca, tmux, your own) it runs as an ordinary
// interactive session; headless, as `claude -p` in auto mode, with a session id
// we choose and structured output from --json-schema.

import { AgentError, type AgentRequest, type Json, printJson } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { claudeHomeOf } from "../../../../../platform/agent-accounts.ts";
import { Home } from "../../../../../platform/home.ts";
import { launcherFor } from "../launchers.ts";
import { type Adapter, type AdapterContext, promptFor, resumingOrStarting } from "./adapter.ts";
import {
  claudeEnvironment,
  ClaudeEvent,
  describeClaudeEvent,
  type ResultEvent,
  transcriptExists,
} from "./claude-events.ts";
import { runInteractiveClaude } from "./claude-interactive.ts";
import { clip, runAgentProcess } from "./process.ts";

export { describeClaudeEvent, transcriptDirectoryFor } from "./claude-events.ts";

export const claudeArgs = (request: AgentRequest, resuming: boolean) => {
  let session = ["--session-id", request.sessionId];

  if (resuming) {
    session = ["--resume", request.sessionId];
  }

  const schema = Option.match(request.outputSchema, {
    onNone: () => [],
    onSome: (json: Json) => ["--json-schema", printJson(json)],
  });

  return [
    "-p",
    ...session,
    "--permission-mode",
    "auto",
    "--output-format",
    "stream-json",
    "--verbose",
    ...schema,
  ];
};

// A background task can wake the session after it answered, and that turn ends
// in a result of its own, often text only; the answer is the last structured one.
const answerOf = (structured: Option.Option<Json>, result: ResultEvent): Json =>
  Option.getOrElse(
    Option.orElse(Option.fromUndefinedOr(result.structured_output), () => structured),
    () => result.result ?? "",
  );

const runHeadless = (request: AgentRequest, context: AdapterContext) =>
  Effect.gen(function* () {
    const home = yield* Home;
    const resuming = yield* transcriptExists(request, claudeHomeOf(context.account, home.user));
    yield* context.log(`claude: ${resumingOrStarting(resuming)} session ${request.sessionId}`);
    let result = Option.none<ResultEvent>();
    let structured = Option.none<Json>();

    const onLine = (line: string) =>
      Option.match(Schema.decodeOption(ClaudeEvent)(line), {
        onNone: () => context.log(clip(line)),
        onSome: (event) => {
          if (event.type === "result" && "is_error" in event) {
            result = Option.some(event);
            structured = Option.orElse(
              Option.fromUndefinedOr(event.structured_output),
              () => structured,
            );
          }

          if (event.type === "assistant" && "message" in event) {
            return Option.match(describeClaudeEvent(event), {
              onNone: () => Effect.void,
              onSome: context.log,
            });
          }

          return Effect.void;
        },
      });

    const finished = yield* runAgentProcess(
      {
        command: "claude",
        args: claudeArgs(request, resuming),
        cwd: request.cwd,
        env: claudeEnvironment(context),
        stdin: promptFor(request, resuming),
      },
      onLine,
    );

    if (Option.isNone(result)) {
      return yield* new AgentError({
        message: `claude exited ${finished.exitCode} without a result: ${clip(finished.stderr, 2000)}`,
      });
    }

    const final = result.value;

    if (final.is_error) {
      return yield* new AgentError({
        message: `claude ended with ${final.subtype}: ${clip(printJson(final.result ?? ""), 2000)}`,
      });
    }

    return {
      sessionId: final.session_id ?? request.sessionId,
      output: answerOf(structured, final),
      costUsd: Option.fromUndefinedOr(final.total_cost_usd),
    };
  });

export const claudeAdapter: Adapter = {
  name: "claude",
  run: (request, context) =>
    Option.match(launcherFor(context.launcher), {
      onNone: () => runHeadless(request, context),
      onSome: (launcher) => runInteractiveClaude(request, context, launcher),
    }),
};
