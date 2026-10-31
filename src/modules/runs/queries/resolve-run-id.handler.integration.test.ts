import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { effectAtHome } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { Home, homePaths } from "../../../platform/home.ts";
import { RunLogsClient } from "../domain/ports/clients/run-logs.client.ts";
import { RunLogsClientLive } from "../infrastructure/clients/run-logs.client-live.ts";
import { resolveRunIdHandler } from "./resolve-run-id.handler.ts";

describe("resolveRunIdHandler", () => {
  effectAtHome("names the run among those with a log, by enough of its id", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = homePaths((yield* Home).root);
      yield* fs.makeDirectory(paths.runs, { recursive: true });
      yield* fs.writeFileString(paths.runLog("3f2a9c1e-aaaa"), "");
      yield* fs.writeFileString(paths.runLog("3f2b0000-bbbb"), "");

      expect(String((yield* resolveRunIdHandler({ asked: "3f2a" })).runId)).toBe("3f2a9c1e-aaaa");
      expect((yield* Effect.flip(resolveRunIdHandler({ asked: "3f2" })))._tag).toBe(
        "AmbiguousRunPrefix",
      );
    }).pipe(Effect.provide(RunLogsClientLive)),
  );

  effectAtHome("names a run whose log a prune removed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = homePaths((yield* Home).root);
      yield* fs.makeDirectory(paths.runs, { recursive: true });
      yield* fs.writeFileString(paths.runLog("3f2a9c1e-aaaa"), "");
      yield* (yield* RunLogsClient).prune(RunId.make("3f2a9c1e-aaaa"));

      expect(String((yield* resolveRunIdHandler({ asked: "3f2a" })).runId)).toBe("3f2a9c1e-aaaa");
    }).pipe(Effect.provide(RunLogsClientLive)),
  );
});
