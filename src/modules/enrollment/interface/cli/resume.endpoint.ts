import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { repoArgument } from "../../../../interface/cli/repo.arguments.ts";
import { type PauseState } from "../../commands/pause-repo.command.ts";
import { EnrollmentCommands } from "../../enrollment.command-handlers.ts";

const describeResumed = (state: PauseState) => `resumed ${state.name}`;

export const resumeEndpoint = Command.make("resume", { repo: repoArgument }, ({ repo }) =>
  EnrollmentCommands.use((enrollment) => enrollment.ResumeRepoCommand({ name: repo })).pipe(
    Effect.flatMap((state) => Console.log(describeResumed(state))),
  ),
).pipe(Command.withDescription("Let a paused repo start runs again"));
