// `chernabog open-pr`, run from the session `chernabog start` opened: it
// records the pull request's title, body and summary as the session's answer
// and ends it, once the worktree is clean. The start flow's run then pushes,
// opens the pull request, waits for CI and asks for a review. The session
// stays open for the person to close.
//
// The agent runs it with --draft instead: that keeps the answer as a draft and
// prints the question to ask the person, whose Yes hands it over (see
// open-pr-question.ts). Without --draft it is the person's own way to finish.

import { printJson } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  Draft,
  handOver,
  questionFor,
  worktreeAt,
} from "../../../modules/runs/infrastructure/runtime/agents/open-pr-question.ts";
import {
  readDecoded,
  SESSION_ENV,
  sessionFilesIn,
} from "../../../modules/runs/infrastructure/runtime/agents/session-files.ts";
import { checkAnswer } from "../../../modules/runs/infrastructure/runtime/agents/stop-hook.ts";
import { LaunchSpecJson } from "../../../modules/runs/infrastructure/runtime/launchers/shim.ts";
import { ConfigError } from "../../../platform/config-error.ts";
import { HostEnvironment } from "../../../platform/environment.ts";

export type OpenPrOptions = {
  readonly title: string;
  readonly body: Option.Option<string>;
  readonly bodyFile: Option.Option<string>;
  readonly summary: Option.Option<string>;
  readonly draft: boolean;
};

const JsonFile = Schema.fromJsonString(Schema.Json);

const refuse = (message: string) => new ConfigError({ message });

const bodyOf = (options: OpenPrOptions) =>
  Option.match(options.bodyFile, {
    onNone: () => Effect.succeed(Option.getOrElse(options.body, () => "")),
    onSome: (file) =>
      FileSystem.FileSystem.use((fs) => fs.readFileString(file)).pipe(
        Effect.mapError((error) => refuse(`could not read ${file}: ${error.message}`)),
      ),
  });

export const openPr = (options: OpenPrOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = Record.get((yield* HostEnvironment).variables, SESSION_ENV);

    if (Option.isNone(dir)) {
      return yield* refuse(
        `run chernabog open-pr from the session chernabog start opened (it sets ${SESSION_ENV})`,
      );
    }

    const files = sessionFilesIn(dir.value);

    if (yield* fs.exists(files.done)) {
      return ["This session already handed its work to chernabog; nothing to do."];
    }

    const spec = yield* readDecoded(LaunchSpecJson, files.spec);

    if (Option.isNone(spec)) {
      return yield* refuse(`${files.dir} is not a session chernabog started`);
    }

    const worktree = yield* worktreeAt(spec.value.cwd);

    if (worktree.uncommitted.length > 0) {
      return yield* refuse(
        `commit or remove these first, then run chernabog open-pr again:\n${worktree.uncommitted}`,
      );
    }

    const answer = printJson({
      title: options.title,
      body: yield* bodyOf(options),
      summary: Option.getOrElse(options.summary, () => options.title),
    });

    const checked = checkAnswer(yield* readDecoded(JsonFile, files.schema), Option.some(answer));

    if (Result.isFailure(checked)) {
      return yield* refuse(
        `this session isn't waiting for a pull request (open-pr ends only the session chernabog start opened): ${checked.failure}`,
      );
    }

    if (options.draft) {
      const draft = { head: worktree.head, answer };
      yield* fs.writeFileString(files.draft, yield* Schema.encodeEffect(Draft)(draft));

      return [
        "Drafted. Now ask the person whether to open it, with AskUserQuestion and exactly this input; only their Yes hands the work to chernabog:",
        printJson(questionFor(draft)),
      ];
    }

    yield* handOver(files, answer);

    return [
      "Handed to chernabog: it runs the local gate, pushes the branch, opens the pull request, waits for CI and asks a reviewer from the pool.",
      "A person merges it. This session stays open; close it when you like. If a review asks for changes, chernabog opens it again.",
    ];
  });
