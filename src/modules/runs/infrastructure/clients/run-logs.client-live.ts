// Run logs as the engine writes them: one file per run, <id>.log in the runs
// folder of the chernabog home. A prune replaces a run's log with an empty
// <id>.pruned beside it, which says the log was there and was removed.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { Home, homePaths } from "../../../../platform/home.ts";
import { RunLogsClient } from "../../domain/ports/clients/run-logs.client.ts";

const LOG = ".log";

const PRUNED = ".pruned";

export const RunLogsClientLive = Layer.effect(
  RunLogsClient,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = homePaths((yield* Home).root);
    const prunedNote = (runId: RunId) => `${paths.runs}/${runId}${PRUNED}`;

    const named = (names: ReadonlyArray<string>, suffix: string) =>
      names.flatMap((name) => {
        if (!name.endsWith(suffix)) {
          return [];
        }

        return [RunId.make(name.slice(0, -suffix.length))];
      });

    // A runs folder that's missing or can't be read holds no logs.
    const ids = fs.readDirectory(paths.runs).pipe(
      Effect.map((names) => Arr.dedupe([...named(names, LOG), ...named(names, PRUNED)])),
      Effect.orElseSucceed((): ReadonlyArray<RunId> => []),
    );

    const readFrom = (runId: RunId, offset: number) =>
      fs.readFileString(paths.runLog(runId)).pipe(
        Effect.map((text) => Option.some(text.slice(offset))),
        Effect.orElseSucceed(() => Option.none<string>()),
      );

    const modifiedAt = (runId: RunId) =>
      fs.stat(paths.runLog(runId)).pipe(
        Effect.map((info) => Option.map(info.mtime, (mtime) => mtime.getTime())),
        Effect.orElseSucceed(() => Option.none<number>()),
      );

    // The note goes first, so a prune a crash interrupts never leaves a run
    // with neither. The runs folder is this module's alone: failing to write
    // it is a bug, not a condition.
    const prune = (runId: RunId) =>
      fs
        .writeFileString(prunedNote(runId), "")
        .pipe(Effect.andThen(fs.remove(paths.runLog(runId), { force: true })), Effect.orDie);

    const pruned = (runId: RunId) =>
      fs.exists(prunedNote(runId)).pipe(Effect.orElseSucceed(() => false));

    return RunLogsClient.of({
      ids,
      pathOf: (runId) => Effect.succeed(paths.runLog(runId)),
      readFrom,
      modifiedAt,
      prune,
      pruned,
    });
  }),
);
