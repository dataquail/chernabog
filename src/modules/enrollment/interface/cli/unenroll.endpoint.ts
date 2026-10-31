import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { repoArgument } from "../../../../interface/cli/repo.arguments.ts";
import {
  DaemonEnrollmentCommands,
  daemonReload,
  throughDaemon,
} from "../../../../interface/daemon/daemon.client.ts";
import { Home, homePaths } from "../../../../platform/home.ts";
import { EnrollmentCommands } from "../../enrollment.command-handlers.ts";

export const unenrollEndpoint = Command.make("unenroll", { repo: repoArgument }, ({ repo }) =>
  Effect.gen(function* () {
    // Through the daemon, which stops scheduling it; here, with none running,
    // a daemon that starts meanwhile reloads on it.
    const removed = yield* throughDaemon(
      DaemonEnrollmentCommands.UnenrollRepoCommand({ name: repo }),
      EnrollmentCommands.use((enrollment) => enrollment.UnenrollRepoCommand({ name: repo })).pipe(
        Effect.tap(() => daemonReload.pipe(Effect.ignore)),
      ),
    );

    const file = homePaths((yield* Home).root).machineConfig;

    yield* Console.log(
      `removed ${removed.name} (${removed.repo}, ${removed.path}) and its settings from ${file}`,
    );
  }),
).pipe(Command.withDescription("Remove a repo, and its settings, from this machine's config"));
