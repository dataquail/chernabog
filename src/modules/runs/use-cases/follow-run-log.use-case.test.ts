import { describe, expect } from "bun:test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { effectOnTestClock } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunLogsClientFake } from "../infrastructure/clients/run-logs.client-fake.ts";
import { followRunLogUseCase } from "./follow-run-log.use-case.ts";

const logs = { a: "started\n" };

describe("followRunLogUseCase", () => {
  effectOnTestClock(
    "streams what the log holds, then what it gains, ending with the last once the run finishes",
    () =>
      Effect.gen(function* () {
        const finished = yield* Deferred.make<boolean>();

        const followed = yield* followRunLogUseCase(RunId.make("a"), Deferred.await(finished)).pipe(
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
      }).pipe(Effect.provide(RunLogsClientFake(logs))),
  );
});
