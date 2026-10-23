// Run logs as the engine writes them: one file per run, <id>.log in the runs
// folder of the chernabog home.

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { Home, homePaths } from "../../../../platform/home.ts";
import { RunLogsClient } from "../../domain/ports/clients/run-logs.client.ts";

const LOG = ".log";

export const RunLogsClientLive = Layer.effect(
  RunLogsClient,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = homePaths((yield* Home).root);

    // A runs folder that's missing or can't be read holds no logs.
    const ids = fs.readDirectory(paths.runs).pipe(
      Effect.map((names) =>
        names
          .filter((name) => name.endsWith(LOG))
          .map((name) => RunId.make(name.slice(0, -LOG.length))),
      ),
      Effect.orElseSucceed((): ReadonlyArray<RunId> => []),
    );

    const readFrom = (runId: RunId, offset: number) =>
      fs.readFileString(paths.runLog(runId)).pipe(
        Effect.map((text) => Option.some(text.slice(offset))),
        Effect.orElseSucceed(() => Option.none<string>()),
      );

    return RunLogsClient.of({
      ids,
      pathOf: (runId) => Effect.succeed(paths.runLog(runId)),
      readFrom,
    });
  }),
);
