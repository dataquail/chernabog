import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { unenrollRepoUseCase } from "../../../modules/enrollment/use-cases/unenroll-repo.use-case.ts";
import { Home, homePaths } from "../../../platform/home.ts";
import { daemonReload } from "../../daemon/daemon.client.ts";
import { repoArgument } from "../repo.arguments.ts";

export const unenrollCommand = Command.make("unenroll", { repo: repoArgument }, ({ repo }) =>
  Effect.gen(function* () {
    const removed = yield* unenrollRepoUseCase(repo);
    const file = homePaths((yield* Home).root).machineConfig;

    yield* Console.log(
      `removed ${removed.name} (${removed.repo}, ${removed.path}) and its settings from ${file}`,
    );
    yield* daemonReload.pipe(Effect.ignore);
  }),
).pipe(Command.withDescription("Remove a repo, and its settings, from this machine's config"));
