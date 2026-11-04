import { describe, expect } from "bun:test";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { RunId } from "../src/kernel/run-id.id.ts";
import { RunLogsClient } from "../src/modules/runs/domain/ports/clients/run-logs.client.ts";
import { RunLogsClientFake } from "../src/modules/runs/infrastructure/clients/run-logs.client-fake.ts";
import { followLog } from "../src/modules/runs/interface/cli/run-log.output.ts";
import { RunLogsQueriesLive } from "../src/modules/runs/runs.query-handlers.ts";
import { effectOnTestClock } from "./effect-test.ts";

const logs = {
  a: "started\n",
  b: "",
  done: "started\nstep: implement\nfinished: done\n",
};

// RunLogsQueries as the CLI dispatches it, over logs in memory.
const queries = RunLogsQueriesLive.pipe(Layer.provide(RunLogsClientFake(logs)));

// The runs a slow read has begun reading, one each time it does.
class Reading extends Context.Service<Reading, Queue.Queue<string>>()("test/Reading") {}

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

  // A read that takes a while, as one from disk does, during which the run
  // may finish: each read names its run on Reading as it begins, and reads
  // the log as it is a few turns of the scheduler later.
  const slowQueries = RunLogsQueriesLive.pipe(
    Layer.provide(
      Layer.effect(
        RunLogsClient,
        Effect.gen(function* () {
          const client = yield* RunLogsClient;
          const reading = yield* Reading;

          return RunLogsClient.of({
            ...client,
            readFrom: (runId, offset) =>
              Queue.offer(reading, runId).pipe(
                Effect.andThen(Effect.yieldNow),
                Effect.andThen(Effect.yieldNow),
                Effect.andThen(client.readFrom(runId, offset)),
              ),
          });
        }),
      ).pipe(Layer.provide(RunLogsClientFake(logs))),
    ),
    Layer.provideMerge(Layer.effect(Reading, Queue.unbounded<string>())),
  );

  effectOnTestClock("streams the whole log of a run that has already finished", () =>
    Effect.gen(function* () {
      const followed = yield* followLog(RunId.make("done"), Effect.void).pipe(
        Effect.flatMap(Stream.runCollect),
      );

      expect(followed.join("\n")).toBe("started\nstep: implement\nfinished: done");
    }).pipe(Effect.provide(slowQueries)),
  );

  effectOnTestClock("loses nothing the log gained as its run finished mid-read", () =>
    Effect.gen(function* () {
      logs.b = "started\n";
      const reading = yield* Reading;
      const finished = yield* Deferred.make<boolean>();

      const followed = yield* followLog(RunId.make("b"), Deferred.await(finished)).pipe(
        Effect.flatMap(Stream.runCollect),
        Effect.forkChild,
      );

      yield* Queue.take(reading);
      logs.b = `${logs.b}finished: done\n`;
      yield* Deferred.succeed(finished, true);

      expect((yield* Fiber.join(followed)).join("\n")).toBe("started\nfinished: done");
    }).pipe(Effect.provide(slowQueries)),
  );
});
