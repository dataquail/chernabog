import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { effectAtHome } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { Home, homePaths } from "../../../platform/home.ts";
import { RunLogsClient } from "../domain/ports/clients/run-logs.client.ts";
import { RunLogsClientLive } from "../infrastructure/clients/run-logs.client-live.ts";
import { readRunLogHandler } from "./read-run-log.handler.ts";

const homeOf = Home.use((home) => Effect.succeed(homePaths(home.root)));

describe("readRunLogHandler", () => {
  effectAtHome("is the run's log as it is now, and where it's kept", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* homeOf;
      yield* fs.makeDirectory(paths.runs, { recursive: true });
      yield* fs.writeFileString(paths.runLog("a"), "step: implement\n");

      const log = yield* readRunLogHandler({ runId: RunId.make("a") });

      expect([log.path, log.text]).toEqual([paths.runLog("a"), "step: implement\n"]);
    }).pipe(Effect.provide(RunLogsClientLive)),
  );

  effectAtHome("fails naming where the log would be, for a run that has written none", () =>
    Effect.gen(function* () {
      const paths = yield* homeOf;

      const refused = yield* Effect.flip(readRunLogHandler({ runId: RunId.make("a") }));

      expect(refused.message).toBe(`no log for a at ${paths.runLog("a")}`);
    }).pipe(Effect.provide(RunLogsClientLive)),
  );

  effectAtHome(
    "fails saying the log was removed after 30 days, for a run a prune removed it of",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* homeOf;
        yield* fs.makeDirectory(paths.runs, { recursive: true });
        yield* fs.writeFileString(paths.runLog("a"), "step: implement\n");
        yield* (yield* RunLogsClient).prune(RunId.make("a"));

        const refused = yield* Effect.flip(readRunLogHandler({ runId: RunId.make("a") }));

        expect([refused._tag, refused.message]).toEqual([
          "RunLogPruned",
          "the log of a was removed after 30 days",
        ]);
      }).pipe(Effect.provide(RunLogsClientLive)),
  );
});
