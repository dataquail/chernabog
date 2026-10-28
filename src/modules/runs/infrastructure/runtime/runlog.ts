// Each run's log is a file under ~/.config/chernabog/runs/, one timestamped
// line per entry. `chernabog logs <run>` prints it; the TUI tails it.

import { RunLog } from "@chernabog/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

export type StepHooks = {
  readonly onStep: (name: string) => Effect.Effect<void>;
  readonly onStepDone: (name: string) => Effect.Effect<void>;
  // A run changed something on GitHub, in a repo by its name, which can tick
  // the repo's flows sooner (#138). `cause` says what, as a tick shows it.
  readonly onChange: (repo: string, cause: string) => Effect.Effect<void>;
};

export const noHooks: StepHooks = {
  onStep: () => Effect.void,
  onStepDone: () => Effect.void,
  onChange: () => Effect.void,
};

const directoryOf = (path: string) =>
  Option.getOrElse(
    Option.liftPredicate(path.slice(0, path.lastIndexOf("/")), (dir) => dir.length > 0),
    () => ".",
  );

// A log that appends to `path`, creating its directory the first time.
export const runLogWriting = (path: string, hooks: StepHooks = noHooks) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const log = (line: string) =>
      Effect.gen(function* () {
        const at = DateTime.formatIso(yield* DateTime.now);
        yield* fs.makeDirectory(directoryOf(path), { recursive: true });
        yield* fs.writeFileString(path, `${at} ${line}\n`, { flag: "a" });
      }).pipe(Effect.orDie);

    return RunLog.of({
      log,
      step: (name) => log(`step: ${name}`).pipe(Effect.andThen(hooks.onStep(name))),
      stepDone: hooks.onStepDone,
    });
  });
