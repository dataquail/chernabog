// An agent from machine config: command templates for starting and resuming,
// with {prompt}, {promptFile}, {sessionId} and {cwd} filled in. Its answer is
// the last JSON object it prints.

import { AgentError } from '@chernabog/sdk';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';

import { type Adapter, agentEnvironment, answerFrom, promptFor, resumingOrStarting, withAnswerFormat } from './adapter.ts';
import { clip, runAgentProcess } from './process.ts';
import { knownSession, rememberSession } from './sessions.ts';

export type CustomAgent = { readonly start: ReadonlyArray<string>; readonly resume: Option.Option<ReadonlyArray<string>> };

export const fillCommand = (template: ReadonlyArray<string>, values: Readonly<Record<string, string>>) =>
  template.map((part) => part.replace(/\{(\w+)\}/g, (placeholder, key: string) => Option.getOrElse(Record.get(values, key), () => placeholder)));

export const customAdapter = (name: string, agent: CustomAgent): Adapter => ({
  name,
  run: (request, context) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const started = Option.isSome(yield* knownSession(name, request.sessionId));
      const resume = Option.filter(agent.resume, () => started);
      const resuming = Option.isSome(resume);
      const scratch = yield* fs.makeTempDirectoryScoped({ prefix: `chernabog-${name}-` });
      const prompt = withAnswerFormat(promptFor(request, resuming), request.outputSchema);
      const promptFile = `${scratch}/prompt.md`;
      yield* fs.writeFileString(promptFile, prompt);
      const template = Option.getOrElse(resume, () => agent.start);
      const [command = 'sh', ...args] = fillCommand(template, { prompt, promptFile, sessionId: request.sessionId, cwd: request.cwd });
      yield* context.log(`${name}: ${resumingOrStarting(resuming)} ${request.sessionId}`);
      yield* rememberSession(name, request.sessionId, request.sessionId);
      let output = '';

      const onLine = (line: string) =>
        Effect.suspend(() => {
          output += `${line}\n`;

          return context.log(clip(line));
        });

      const finished = yield* runAgentProcess({ command, args, cwd: request.cwd, env: agentEnvironment(context, {}, []), stdin: prompt }, onLine);

      if (finished.exitCode !== 0) return yield* new AgentError({ message: `${name} exited ${finished.exitCode}: ${clip(finished.stderr, 2000)}` });

      return { sessionId: request.sessionId, output: answerFrom(output, request.outputSchema), costUsd: Option.none<number>() };
    }).pipe(
      Effect.scoped,
      Effect.catchTag('PlatformError', (error) => Effect.fail(new AgentError({ message: `${name}: ${error.message}` }))),
    ),
});
