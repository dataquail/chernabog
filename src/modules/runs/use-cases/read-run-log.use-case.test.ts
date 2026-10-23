import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunLogsClientFake } from "../infrastructure/clients/run-logs.client-fake.ts";
import { readRunLogUseCase } from "./read-run-log.use-case.ts";

describe("readRunLogUseCase", () => {
  effect("is the run's log as it is now, and where it's kept", () =>
    Effect.gen(function* () {
      const log = yield* readRunLogUseCase(RunId.make("a"));

      expect([log.path, log.text]).toEqual(["/runs/a.log", "step: implement\n"]);
    }).pipe(Effect.provide(RunLogsClientFake({ a: "step: implement\n" }))),
  );

  effect("fails naming where the log would be, for a run that has written none", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(readRunLogUseCase(RunId.make("a")));

      expect(refused.message).toBe("no log for a at /runs/a.log");
    }).pipe(Effect.provide(RunLogsClientFake({}))),
  );
});
