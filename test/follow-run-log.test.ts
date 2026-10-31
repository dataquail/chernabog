import { describe, expect } from "bun:test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { followLog } from "../src/interface/cli/runs/run-log.output.ts";
import { RunId } from "../src/kernel/run-id.id.ts";
import { RunLogsClientFake } from "../src/modules/runs/infrastructure/clients/run-logs.client-fake.ts";
import { RunLogsQueriesLive } from "../src/modules/runs/runs.query-handlers.ts";
import { effectOnTestClock } from "./effect-test.ts";

const logs = { a: "started\n" };

// RunLogsQueries as the CLI dispatches it, over logs in memory.
const queries = RunLogsQueriesLive.pipe(Layer.provide(RunLogsClientFake(logs)));

describe("followLog", () => {
  effectOnTestClock(
    "streams what the log holds, then what it gains, ending with the last once the run finishes",
    () =>
      Effect.gen(function* () {
        const finished = yield* Deferred.make<boolean>();

        const followed = yield* followLog(RunId.make("a"), Deferred.await(finished)).pipe(
          Effect.flatMap(Stream.runCollect),
          Effect.forkChild,
        );

        yield* Effect.yieldNow;

        yield* TestClock.adjust("1 second");
        logs.a = `${logs.a}step: implement\n`;
        yield* TestClock.adjust("1 second");
        logs.a = `${logs.a}finished: done\n`;
        yield* Deferred.succeed(finished, true);

        expect(yield* Fiber.join(followed)).toEqual([
          "started",
          "step: implement",
          "finished: done",
        ]);
      }).pipe(Effect.provide(queries)),
  );
});
