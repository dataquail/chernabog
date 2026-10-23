import { defineFlow, RunLog } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { item, makeFake, repo, runToEnd } from "../../../../../test/sdk-fakes.ts";
import { flowHandle } from "../../../../engine.ts";

// A flow whose workflow logs a line and ends with what its item says.
const flow = defineFlow({
  trigger: Effect.succeed([]),
  workflow: (work) =>
    RunLog.use((log) => log.log(`working on ${work.key}`)).pipe(Effect.as(`did ${work.key}`)),
});

describe("WorkflowsClientLive", () => {
  effect("executes a run's workflow in the engine, and polls how it ended", () =>
    Effect.gen(function* () {
      const finished = yield* runToEnd(
        flowHandle(repo, "demo", flow),
        makeFake("approve"),
        item("pr-1"),
      );

      expect(finished.status).toBe("done");
      expect(finished.summary).toEqual(Option.some("did pr-1"));
    }),
  );
});
