// What both ways of running Claude Code share: the environment it runs with,
// where it keeps a session's transcript, and how its messages read in a run log.

import type { AgentRequest } from '@chernabog/sdk';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

import { claudeTokenVariables } from '../config.ts';
import { type AdapterContext, agentEnvironment } from './adapter.ts';
import { clip } from './process.ts';

// Claude keeps a session's transcript under the directory it ran in, with every non-alphanumeric replaced by a dash.
export const transcriptDirectoryFor = (worktreePath: string) => worktreePath.replace(/[^a-zA-Z0-9]/g, '-');

const TextBlock = Schema.Struct({ type: Schema.Literal('text'), text: Schema.String });

const ToolInput = Schema.Struct({
  command: Schema.optionalKey(Schema.String),
  file_path: Schema.optionalKey(Schema.String),
  pattern: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
});

const ToolUse = Schema.Struct({ type: Schema.Literal('tool_use'), name: Schema.String, input: ToolInput });
const OtherBlock = Schema.Struct({ type: Schema.String });

export const Assistant = Schema.Struct({ type: Schema.Literal('assistant'), message: Schema.Struct({ content: Schema.Array(Schema.Union([TextBlock, ToolUse, OtherBlock])) }) });

export const ResultEvent = Schema.Struct({
  type: Schema.Literal('result'),
  subtype: Schema.String,
  is_error: Schema.Boolean,
  session_id: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Json),
  structured_output: Schema.optionalKey(Schema.Json),
  total_cost_usd: Schema.optionalKey(Schema.Finite),
});

export type ResultEvent = typeof ResultEvent.Type;

export const ClaudeEvent = Schema.fromJsonString(Schema.Union([Assistant, ResultEvent, OtherBlock]));

const describeBlock = (block: typeof Assistant.Type['message']['content'][number]): ReadonlyArray<string> => {
  if ('text' in block && block.text.trim().length > 0) return [clip(block.text.trim().replace(/\s+/g, ' '))];

  if ('input' in block) {
    const input = block.input;
    const target = input.command ?? input.file_path ?? input.pattern ?? input.description ?? '';

    return [`${block.name}(${clip(target, 120)})`];
  }

  return [];
};

// One readable log line per assistant message or tool call, from stream-json output or a transcript.
export const describeClaudeEvent = (event: typeof Assistant.Type) => {
  const parts = event.message.content.flatMap(describeBlock);

  if (parts.length === 0) return Option.none<string>();

  return Option.some(parts.join(' · '));
};

const AssistantLine = Schema.fromJsonString(Assistant);

// A transcript line as a log line, when it is an assistant message worth showing.
export const describeTranscriptLine = (line: string) => Option.flatMap(Schema.decodeOption(AssistantLine)(line), describeClaudeEvent);

// What a Claude Code session sets for the processes it starts. Started from
// inside one (`chernabog run` in a Claude session), the agent would take
// itself for that session's child and keep no transcript of its own.
const sessionMarkers = (context: AdapterContext) => Object.keys({ ...context.host, ...context.env }).filter((name) => name === 'CLAUDECODE' || name.startsWith('CLAUDE_CODE_'));

// The account's config directory set, or unset for the default one; API keys
// and a calling session's markers removed. The markers include
// CLAUDE_CODE_OAUTH_TOKEN, which comes back only for an account with its own
// token, taken from the host, never from the repo's committed env.
export const claudeEnvironment = (context: AdapterContext) => ({
  ...Option.match(context.account.configDir, {
    onNone: () => agentEnvironment(context, {}, ['CLAUDE_CONFIG_DIR', ...sessionMarkers(context)]),
    onSome: (dir) => agentEnvironment(context, { CLAUDE_CONFIG_DIR: dir }, sessionMarkers(context)),
  }),
  ...claudeTokenVariables(context.account, context.host),
});

// Claude names a project's directory after the real path it runs in, symlinks resolved.
export const transcriptFile = (request: AgentRequest, configDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const real = yield* fs.realPath(request.cwd).pipe(Effect.orElseSucceed(() => request.cwd));

    return `${configDir}/projects/${transcriptDirectoryFor(real)}/${request.sessionId}.jsonl`;
  });

export const transcriptExists = (request: AgentRequest, configDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs.exists(yield* transcriptFile(request, configDir));
  }).pipe(Effect.orElseSucceed(() => false));
