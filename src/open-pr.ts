// `chernabog open-pr`, run from the session `chernabog start` opened, by the
// agent or the person: it records the pull request's title, body and summary
// as the session's answer and ends it, once the worktree is clean. The start
// flow's run then pushes, opens the pull request, waits for CI and asks for a
// review. The session stays open for the person to close.

import { printJson } from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { Done, readDecoded, SESSION_ENV, sessionFilesIn } from "./agents/session-files.ts";
import { checkAnswer } from "./agents/stop-hook.ts";
import { ConfigError } from "./config.ts";
import { Exec } from "./Exec.ts";
import { LaunchSpecJson } from "./launchers/shim.ts";
import { HostEnvironment } from "./platform/environment.ts";

export type OpenPrOptions = {
  readonly title: string;
  readonly body: Option.Option<string>;
  readonly bodyFile: Option.Option<string>;
  readonly summary: Option.Option<string>;
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

// Uncommitted changes in the session's worktree, as git status lists them.
const uncommitted = (cwd: string) =>
  Effect.gen(function* () {
    const status = yield* (yield* Exec).run("git", ["status", "--porcelain"], { cwd });

    if (status.exitCode !== 0) {
      return yield* refuse(
        `git status in ${cwd} exited ${status.exitCode}: ${status.stderr.trim()}`,
      );
    }

    return status.stdout.trimEnd();
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

    const changes = yield* uncommitted(spec.value.cwd);

    if (changes.length > 0) {
      return yield* refuse(
        `commit or remove these first, then run chernabog open-pr again:\n${changes}`,
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

    yield* fs.writeFileString(files.answer, answer);
    yield* fs.writeFileString(files.done, yield* Schema.encodeEffect(Done)({ ok: true }));

    return [
      "Handed to chernabog: it runs the local gate, pushes the branch, opens the pull request, waits for CI and asks a reviewer from the pool.",
      "A person merges it. This session stays open; close it when you like. If a review asks for changes, chernabog opens it again.",
    ];
  });
