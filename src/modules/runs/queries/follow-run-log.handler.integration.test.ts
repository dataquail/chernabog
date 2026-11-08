import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { effectAtHome } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunLogLines } from "../../../kernel/run-log-line.value-object.ts";
import { Home, homePaths } from "../../../platform/home.ts";
import { RunLogsClientLive } from "../infrastructure/clients/run-logs.client-live.ts";
import { followRunLogHandler } from "./follow-run-log.handler.ts";

const a = RunId.make("a");

// Writes run a's log in the scratch home's runs folder, as the engine does.
const writeLog = (text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = homePaths((yield* Home).root);
    yield* fs.makeDirectory(paths.runs, { recursive: true });
    yield* fs.writeFileString(paths.runLog(a), text);
  });

describe("followRunLogHandler", () => {
  effectAtHome(
    "reads what the log gained from an offset, as one piece, and where to read next",
    () =>
      Effect.gen(function* () {
        yield* writeLog("started\n");
        const first = yield* followRunLogHandler({ runId: a, from: 0 });

        expect([first.text, first.next]).toEqual([Option.some("started"), 8]);

        yield* writeLog("started\nstep: implement\nfinished: done\n");
        const second = yield* followRunLogHandler({ runId: a, from: first.next });

        expect([second.text, second.next]).toEqual([
          Option.some("step: implement\nfinished: done"),
          39,
        ]);
        expect(yield* followRunLogHandler({ runId: a, from: second.next })).toMatchObject({
          text: Option.none(),
          next: 39,
        });
      }).pipe(Effect.provide(RunLogsClientLive)),
  );

  effectAtHome("gains nothing from a log not written yet, or only whitespace", () =>
    Effect.gen(function* () {
      yield* writeLog("\n\n");

      expect(yield* followRunLogHandler({ runId: RunId.make("b"), from: 0 })).toMatchObject({
        text: Option.none(),
        next: 0,
      });
      expect(yield* followRunLogHandler({ runId: a, from: 0 })).toMatchObject({
        text: Option.none(),
        next: 2,
      });
    }).pipe(Effect.provide(RunLogsClientLive)),
  );

  effectAtHome("with a step and its node, reads that step's lines at that node alone", () =>
    Effect.gen(function* () {
      const T = "2026-11-08T10:00:00.000Z";

      yield* writeLog(
        [
          RunLogLines.entry(
            T,
            Option.some("ci"),
            "round one",
            Option.some('{"id":"ci","round":1}'),
          ),
          RunLogLines.entry(
            T,
            Option.some("ci"),
            "round two",
            Option.some('{"id":"ci","round":2}'),
          ),
          "",
        ].join("\n"),
      );

      const read = yield* followRunLogHandler({
        runId: a,
        from: 0,
        step: { name: "ci", logs: "tagged", node: { id: "ci", round: 2 } },
      });

      expect(read.text).toEqual(Option.some(`${T} round two`));
    }).pipe(Effect.provide(RunLogsClientLive)),
  );
});
