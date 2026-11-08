import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { effectAtHome } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunLogLines } from "../../../kernel/run-log-line.value-object.ts";
import { Home, homePaths } from "../../../platform/home.ts";
import { NodeRef } from "../domain/plan/node-ref.value-object.ts";
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

  effectAtHome(
    "with steps to keep, is only those steps' lines at their nodes, a continued entry and all",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* homeOf;
        const at = "2026-11-08T14:00:00.000Z";

        yield* fs.makeDirectory(paths.runs, { recursive: true });
        yield* fs.writeFileString(
          paths.runLog("a"),
          [
            RunLogLines.entry(at, Option.some("read-trigger"), "read the trigger"),
            RunLogLines.entry(
              at,
              Option.some("ci"),
              "round one",
              Option.some('{"id":"ci","round":1}'),
            ),
            RunLogLines.entry(
              at,
              Option.some("ci"),
              "round two\nstill round two",
              Option.some('{"id":"ci","round":2}'),
            ),
            RunLogLines.entry(
              at,
              Option.some("implement"),
              "implementing",
              Option.some('{"id":"implement","round":2}'),
            ),
            "",
          ].join("\n"),
        );

        const log = yield* readRunLogHandler({
          runId: RunId.make("a"),
          only: [{ step: "ci", node: NodeRef.make({ id: "ci", round: 2 }) }],
        });

        expect(log.text).toBe(`${at} round two\nstill round two`);

        const setUp = yield* readRunLogHandler({
          runId: RunId.make("a"),
          only: [{ step: "read-trigger" }],
        });

        expect(setUp.text).toBe(`${at} read the trigger`);
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
