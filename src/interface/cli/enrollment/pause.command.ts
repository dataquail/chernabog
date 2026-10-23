import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { pauseRepoUseCase } from "../../../modules/enrollment/use-cases/pause-repo.use-case.ts";
import { type PauseState } from "../../../modules/enrollment/use-cases/pause-state.result.ts";
import { repoArgument } from "../repo.arguments.ts";

const describePaused = (state: PauseState) =>
  `paused ${state.name}: no new runs start; runs in flight continue`;

export const pauseCommand = Command.make("pause", { repo: repoArgument }, ({ repo }) =>
  pauseRepoUseCase(repo).pipe(Effect.flatMap((state) => Console.log(describePaused(state)))),
).pipe(Command.withDescription("Start no new runs in a repo"));
