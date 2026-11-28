// What `chernabog open-pr` does to a session with a person, wherever it is
// asked from: the CLI on the host, or the session API's `open-pr` command
// (ADR 24, #715), which a sandboxed agent reaches over HTTP. Once the
// worktree is clean and the session is waiting for a pull request, it keeps
// a draft and gives the question to ask the person, or, without draft, the
// person's own way to finish, hands the work over.

import { printJson } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { ConfigError } from "../../../../../platform/config-error.ts";
import { LaunchSpecJson } from "../launchers/shim.ts";
import { Draft, handOver, questionFor, worktreeAt } from "./open-pr-question.ts";
import { readDecoded, type SessionFiles } from "./session-files.ts";
import { checkAnswer } from "./stop-hook.ts";

export type PullRequestFields = {
  readonly title: string;
  readonly body: string;
  readonly summary: Option.Option<string>;
  readonly draft: boolean;
};

const JsonFile = Schema.fromJsonString(Schema.Json);

const refuse = (message: string) => new ConfigError({ message });

// The lines to print: what happened, and for a draft the question to ask.
export const recordPullRequest = (files: SessionFiles, fields: PullRequestFields) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

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
      title: fields.title,
      body: fields.body,
      summary: Option.getOrElse(fields.summary, () => fields.title),
    });

    const checked = checkAnswer(yield* readDecoded(JsonFile, files.schema), Option.some(answer));

    if (Result.isFailure(checked)) {
      return yield* refuse(
        `this session isn't waiting for a pull request (open-pr ends only the session chernabog start opened): ${checked.failure}`,
      );
    }

    if (fields.draft) {
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
