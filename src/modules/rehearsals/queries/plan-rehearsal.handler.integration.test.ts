import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { ScenarioRoot } from "../domain/scenario/scenario.root.ts";
import { planRehearsalHandler } from "./plan-rehearsal.handler.ts";

describe("planRehearsalHandler", () => {
  effect("stands in with a replay's answers, the scenario's own over them", () =>
    Effect.gen(function* () {
      const scenario = ScenarioRoot.make({
        path: "/r/s.yaml",
        dir: "/r",
        repo: "you/scratch",
        agent: { implement: { script: "./implement.sh" } },
      });

      const plan = yield* planRehearsalHandler({
        scenario,
        replayed: [
          { step: "implement", answer: { status: "done" }, commits: ["Do it"] },
          { step: "fix-ci-1", answer: { status: "done" }, commits: [] },
        ],
      });

      expect(plan.standIns).toEqual({
        implement: { script: "./implement.sh" },
        "fix-ci-1": { fixture: { status: "done" }, commits: [] },
      });
    }),
  );
});
