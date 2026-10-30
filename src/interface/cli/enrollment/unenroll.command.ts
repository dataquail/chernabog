import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { EnrollmentCommands } from "../../../modules/enrollment/enrollment.command-handlers.ts";
import { Home, homePaths } from "../../../platform/home.ts";
import { daemonReload } from "../../daemon/daemon.client.ts";
import { repoArgument } from "../repo.arguments.ts";

export const unenrollCommand = Command.make("unenroll", { repo: repoArgument }, ({ repo }) =>
  Effect.gen(function* () {
    const removed = yield* EnrollmentCommands.use((enrollment) =>
      enrollment.UnenrollRepoCommand({ name: repo }),
    );

    const file = homePaths((yield* Home).root).machineConfig;

    yield* Console.log(
      `removed ${removed.name} (${removed.repo}, ${removed.path}) and its settings from ${file}`,
    );
    yield* daemonReload.pipe(Effect.ignore);
  }),
).pipe(Command.withDescription("Remove a repo, and its settings, from this machine's config"));
