// `chernabog open-pr`, run from the session `chernabog start` opened: it
// records the pull request's title, body and summary as the session's answer
// and ends it, once the worktree is clean. The start flow's run then pushes,
// opens the pull request, waits for CI and asks for a review. The session
// stays open for the person to close.
//
// The agent runs it with --draft instead: that keeps the answer as a draft and
// prints the question to ask the person, whose Yes hands it over (see
// open-pr-question.ts). Without --draft it is the person's own way to finish.

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import {
  recordPullRequest,
  SESSION_ENV,
  sessionFilesIn,
} from "../../modules/runs/runs.platform.ts";
import { ConfigError } from "../../platform/config-error.ts";
import { HostEnvironment } from "../../platform/environment.ts";

export type OpenPrOptions = {
  readonly title: string;
  readonly body: Option.Option<string>;
  readonly bodyFile: Option.Option<string>;
  readonly summary: Option.Option<string>;
  readonly draft: boolean;
};

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
    const dir = Record.get((yield* HostEnvironment).variables, SESSION_ENV);

    if (Option.isNone(dir)) {
      return yield* refuse(
        `run chernabog open-pr from the session chernabog start opened (it sets ${SESSION_ENV})`,
      );
    }

    return yield* recordPullRequest(sessionFilesIn(dir.value), {
      title: options.title,
      body: yield* bodyOf(options),
      summary: options.summary,
      draft: options.draft,
    });
  });
