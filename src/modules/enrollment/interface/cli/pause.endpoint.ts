import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { repoArgument } from "../../../../interface/cli/repo.arguments.ts";
import { type PauseState } from "../../commands/pause-repo.command.ts";
import { EnrollmentCommands } from "../../enrollment.command-handlers.ts";

const describePaused = (state: PauseState) =>
  `paused ${state.name}: no new runs start; runs in flight continue`;

export const pauseEndpoint = Command.make("pause", { repo: repoArgument }, ({ repo }) =>
  EnrollmentCommands.use((enrollment) => enrollment.PauseRepoCommand({ name: repo })).pipe(
    Effect.flatMap((state) => Console.log(describePaused(state))),
  ),
).pipe(Command.withDescription("Start no new runs in a repo"));
