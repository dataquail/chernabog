import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { RunLogsClientFake } from "../infrastructure/clients/run-logs.client-fake.ts";
import { resolveRunIdHandler } from "./resolve-run-id.handler.ts";

describe("resolveRunIdHandler", () => {
  effect("names the run among those with a log, by enough of its id", () =>
    Effect.gen(function* () {
      expect(String((yield* resolveRunIdHandler({ asked: "3f2a" })).runId)).toBe("3f2a9c1e-aaaa");
      expect((yield* Effect.flip(resolveRunIdHandler({ asked: "3f2" })))._tag).toBe(
        "AmbiguousRunPrefix",
      );
    }).pipe(Effect.provide(RunLogsClientFake({ "3f2a9c1e-aaaa": "", "3f2b0000-bbbb": "" }))),
  );
});
