import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { effectAtHome } from "../../../../../test/effect-test.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import { Home, homePaths } from "../../../../platform/home.ts";
import { RunLogsClient } from "../../domain/ports/clients/run-logs.client.ts";
import { RunLogsClientLive } from "./run-logs.client-live.ts";

const opened = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = homePaths((yield* Home).root);

  return { fs, paths, logs: yield* RunLogsClient };
}).pipe(Effect.provide(RunLogsClientLive));

describe("RunLogsClientLive", () => {
  effectAtHome("lists the runs with a log, and reads one from an offset", () =>
    Effect.gen(function* () {
      const { fs, logs, paths } = yield* opened;
      yield* fs.makeDirectory(paths.runs, { recursive: true });
      yield* fs.writeFileString(paths.runLog("a"), "step: implement\nfinished: done\n");
      yield* fs.writeFileString(`${paths.runs}/notes.txt`, "not a log");

      expect(yield* logs.ids).toEqual([RunId.make("a")]);
      expect(yield* logs.pathOf(RunId.make("a"))).toBe(paths.runLog("a"));
      expect(yield* logs.readFrom(RunId.make("a"), 16)).toEqual(Option.some("finished: done\n"));
    }),
  );

  effectAtHome("has no logs before any run, and none for a run that hasn't written one", () =>
    Effect.gen(function* () {
      const { logs } = yield* opened;

      expect(yield* logs.ids).toEqual([]);
      expect(yield* logs.readFrom(RunId.make("a"), 0)).toEqual(Option.none());
    }),
  );

  effectAtHome("prunes a log to a note, and still lists its run, whose log reads as gone", () =>
    Effect.gen(function* () {
      const { fs, logs, paths } = yield* opened;
      const a = RunId.make("a");
      yield* fs.makeDirectory(paths.runs, { recursive: true });
      yield* fs.writeFileString(paths.runLog("a"), "step: implement\n");
      yield* fs.utimes(paths.runLog("a"), 0, 1);

      expect([yield* logs.modifiedAt(a), yield* logs.pruned(a)]).toEqual([
        Option.some(1_000),
        false,
      ]);

      yield* logs.prune(a);

      expect(yield* logs.ids).toEqual([a]);
      expect(yield* logs.readFrom(a, 0)).toEqual(Option.none());
      expect([yield* logs.modifiedAt(a), yield* logs.pruned(a)]).toEqual([Option.none(), true]);
    }),
  );
});
