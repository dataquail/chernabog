// Subjects: the work items a run touched, by key (`issue-12`, `pr-40`,
// `release-1.4`), beyond the item it was started for. The engine records
// them against the run, gives them to the flow's stillValid (Run's
// subjects), and the live view threads runs that share one into one piece
// of work. The engine knows nothing of what a key means: a block names what
// it opened, adopted or released.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// Records what a run touched. Provided by Chernabog.
export class RunSubjects extends Context.Service<
  RunSubjects,
  {
    // Naming one again changes nothing.
    name(subject: string): Effect.Effect<void>;
  }
>()("@chernabog/sdk/RunSubjects") {}

// Names `subject` as something this run touched, such as the pull request
// it opened: `name(Claims.pullRequest(40))`. Safe to repeat, so a run that
// resumes may name it again. Outside a run the engine records, it does nothing.
export const name = (subject: string) =>
  Effect.serviceOption(RunSubjects).pipe(
    Effect.flatMap(
      Option.match({ onNone: () => Effect.void, onSome: (subjects) => subjects.name(subject) }),
    ),
  );
