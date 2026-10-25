// An agent that never starts one (#115): each step is answered by its
// stand-in, a script run in the worktree or a fixed answer, so a rehearsal
// spends no tokens and launches no session. A step with no stand-in fails,
// naming the step, rather than falling through to a real agent. The flow's
// blocks decode the answer against the step's schema, as they do a real
// agent's.

import { AgentError, printJson } from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import {
  isScript,
  type StandIn,
  standInFor,
  type StandIns,
} from "../../../../../kernel/stand-in.value-object.ts";
import { type Environment } from "../../../../../platform/environment.ts";
import { Exec } from "../../../../../platform/exec.ts";
import {
  type Adapter,
  type AdapterContext,
  agentEnvironment,
  answerFrom,
  promptFor,
  withAnswerFormat,
} from "./adapter.ts";
import { clip, runAgentProcess } from "./process.ts";
import { knownSession, rememberSession } from "./sessions.ts";

export const REHEARSAL = "rehearsal";

// `dir` is the directory of the file that names the stand-ins, which a script
// reads as CHERNABOG_STAND_INS to find files beside it; it runs in the worktree.
export type RehearsalAgent = {
  readonly standIns: StandIns;
  readonly dir: string;
};

const failed = (message: string) => new AgentError({ message: `${REHEARSAL}: ${message}` });

const runScript = (
  script: string,
  prompt: string,
  env: Environment,
  cwd: string,
  context: AdapterContext,
) =>
  Effect.gen(function* () {
    let output = "";

    const onLine = (line: string) =>
      Effect.suspend(() => {
        output += `${line}\n`;

        return context.log(clip(line));
      });

    const finished = yield* runAgentProcess(
      { command: "/bin/sh", args: ["-c", script], cwd, env, stdin: prompt },
      onLine,
    );

    if (finished.exitCode !== 0) {
      return yield* failed(`${script} exited ${finished.exitCode}: ${clip(finished.stderr, 2000)}`);
    }

    return output;
  });

// Who placeholder commits are by: they stand for no one's work, and a host
// with no git identity of its own, such as CI, can still make them.
const PLACEHOLDER_AUTHOR = { name: "Chernabog rehearsal", email: "rehearsal@chernabog.invalid" };

// One commit per message, each adding a file under .rehearsal/, so a step's
// work is something to push.
const commitPlaceholders = (
  step: string,
  messages: ReadonlyArray<string>,
  env: Environment,
  cwd: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exec = yield* Exec;
    yield* fs.makeDirectory(`${cwd}/.rehearsal`, { recursive: true });

    for (const [index, message] of messages.entries()) {
      const file = `.rehearsal/${step}-${index + 1}.txt`;
      yield* fs.writeFileString(`${cwd}/${file}`, `${message}\n`);

      for (const args of [
        ["add", file],
        [
          "-c",
          `user.name=${PLACEHOLDER_AUTHOR.name}`,
          "-c",
          `user.email=${PLACEHOLDER_AUTHOR.email}`,
          "commit",
          "-m",
          message,
        ],
      ]) {
        const result = yield* exec.run("git", args, { cwd, env });

        if (result.exitCode !== 0) {
          return yield* failed(`git ${args[0]} in ${cwd}: ${clip(result.stderr.trim(), 2000)}`);
        }
      }
    }
  }).pipe(Effect.catchTag("ExecError", (error) => Effect.fail(failed(error.message))));

const answer = (
  standIn: StandIn,
  step: string,
  prompt: string,
  env: Environment,
  cwd: string,
  context: AdapterContext,
) => {
  if (isScript(standIn)) {
    return runScript(standIn.script, prompt, env, cwd, context);
  }

  return commitPlaceholders(step, standIn.commits ?? [], env, cwd).pipe(
    Effect.as(printJson(standIn.fixture)),
  );
};

export const rehearsalAdapter = (agent: RehearsalAgent): Adapter => ({
  name: REHEARSAL,
  run: (request, context) =>
    Effect.gen(function* () {
      const step = Option.fromUndefinedOr(request.step);

      if (Option.isNone(step)) {
        return yield* failed(
          "the agent was asked outside any step, so no stand-in can answer it; call Agent inside an activity",
        );
      }

      const standIn = standInFor(agent.standIns, step.value);

      if (Option.isNone(standIn)) {
        return yield* failed(
          `no stand-in for step ${step.value}; add one under agent: (by step name, or a pattern such as ${step.value.replace(/-\d+$/, "-*")})`,
        );
      }

      const resuming = Option.isSome(yield* knownSession(REHEARSAL, request.sessionId));
      const prompt = withAnswerFormat(promptFor(request, resuming), request.outputSchema);
      yield* rememberSession(REHEARSAL, request.sessionId, request.sessionId);
      yield* context.log(`${REHEARSAL}: ${step.value} answered by its stand-in`);

      const env = agentEnvironment(
        context,
        {
          CHERNABOG_STEP: step.value,
          CHERNABOG_SESSION_ID: request.sessionId,
          CHERNABOG_STAND_INS: agent.dir,
        },
        [],
      );

      const output = yield* answer(standIn.value, step.value, prompt, env, request.cwd, context);

      return {
        sessionId: request.sessionId,
        output: answerFrom(output, request.outputSchema),
        costUsd: Option.none<number>(),
      };
    }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(failed(error.message)))),
});
