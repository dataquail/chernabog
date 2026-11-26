// chernabog sandbox: the image a repo's sandboxed sessions run in (ADR 24).
// `init` writes the template Dockerfile into .chernabog/sandbox/, which the
// repo then owns and edits for its toolchain. There's no published base image
// (decision 11): the template is copied into each repo.

import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { rootOf } from "../../modules/enrollment/interface/cli/enrollment.endpoint-groups.ts";
import { ConfigError } from "../../platform/config-error.ts";
import { SANDBOX_TEMPLATES } from "../../platform/templates.ts";

const DIRECTORY = ".chernabog/sandbox";
const DOCKERFILE = `${DIRECTORY}/Dockerfile`;

// Writes the template, refusing to write over a Dockerfile that's there: it
// is the repo's own, edited or not.
export const writeSandboxTemplate = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${root}/${DOCKERFILE}`;

    if (yield* fs.exists(file)) {
      return yield* new ConfigError({
        message: `${DOCKERFILE} is already there; sandbox init writes nothing over it. Edit it, or delete it first to start again from the template`,
      });
    }

    yield* fs.makeDirectory(`${root}/${DIRECTORY}`, { recursive: true });
    // wx: refuses a file that appeared since the check, rather than writing over it.
    yield* fs.writeFileString(file, SANDBOX_TEMPLATES.Dockerfile, { flag: "wx" });

    return [
      `wrote ${DOCKERFILE}`,
      "Next: add the repo's toolchain where it says so, commit it and merge it to the base branch.",
    ];
  }).pipe(
    Effect.catchTag(
      "PlatformError",
      (error) => new ConfigError({ message: `writing ${DOCKERFILE}: ${error.message}` }),
    ),
  );

const init = Command.make(
  "init",
  {
    path: Argument.String("path").pipe(
      Argument.withDescription("The checkout; the one this directory is in when left out"),
      Argument.optional,
    ),
  },
  ({ path }) =>
    Effect.gen(function* () {
      const lines = yield* writeSandboxTemplate(yield* rootOf(path));

      for (const line of lines) {
        yield* Console.log(line);
      }
    }),
).pipe(
  Command.withDescription(
    "Write a template Dockerfile (a Containerfile too) to .chernabog/sandbox/, for the repo's sandboxed sessions to run in; refuses to write over one",
  ),
);

export const sandboxCommand = Command.make("sandbox").pipe(
  Command.withDescription("The container image a repo's sandboxed agent sessions run in"),
  Command.withSubcommands([init]),
);
