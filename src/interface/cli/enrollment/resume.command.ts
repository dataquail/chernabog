import * as Command from 'effect/cli/Command';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';

import { type PauseState } from '../../../modules/enrollment/use-cases/pause-state.result.ts';
import { resumeRepoUseCase } from '../../../modules/enrollment/use-cases/resume-repo.use-case.ts';
import { repoArgument } from '../repo.arguments.ts';

const describeResumed = (state: PauseState) => `resumed ${state.name}`;

export const resumeCommand = Command.make('resume', { repo: repoArgument }, ({ repo }) => resumeRepoUseCase(repo).pipe(Effect.flatMap((state) => Console.log(describeResumed(state))))).pipe(
  Command.withDescription('Let a paused repo start runs again'),
);
