// A step a team writes as Effect code in .chernabog/stages/<name>.ts. It runs
// in a child process, gets its input checked against `input` and its output
// against `output`. A step that crashes partway runs again, so it must be safe
// to repeat: "claim unless this run already holds it".

import type * as Effect from 'effect/Effect';
import type * as Schema from 'effect/Schema';

import type { Json } from './json.ts';
import type { Agent, Git, GitHub, Repo, Run, RunLog, Usage, Worktree } from './services.ts';

export type StageServices = Repo | Run | GitHub | Git | Worktree | Usage | Agent | RunLog;

export type Stage<I, O, E> = {
  readonly name: string;
  // Both cross a process boundary as JSON.
  readonly input: Schema.Codec<I, Json>;
  readonly output: Schema.Codec<O, Json>;
  readonly run: (input: I) => Effect.Effect<O, E, StageServices>;
};

export const defineStage = <I, O, E>(stage: Stage<I, O, E>): Stage<I, O, E> => stage;

// What a step's process says on exit: 0 to continue, 78 to skip, anything else to fail.
export const STEP_EXIT = { ok: 0, skip: 78 } as const;
