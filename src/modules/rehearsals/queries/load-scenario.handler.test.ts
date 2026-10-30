import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { ScenarioRoot } from "../domain/scenario/scenario.root.ts";
import { ScenariosRepositoryFake } from "../infrastructure/repositories/scenarios.repository-fake.ts";
import { loadScenarioHandler } from "./load-scenario.handler.ts";

const PATH = "/repo/.chernabog/rehearsals/implement.yaml";

const scenarios = (repo: string, flow: Option.Option<string> = Option.none()) => {
  const base = { path: PATH, dir: "/repo/.chernabog/rehearsals", repo };

  return ScenariosRepositoryFake({
    [PATH]: Option.match(flow, {
      onNone: () => ScenarioRoot.make(base),
      onSome: (named) => ScenarioRoot.make({ ...base, flow: named }),
    }),
  });
};

const request = { path: PATH, flow: "implement", enrolled: ["you/app"], allowEnrolled: false };

describe("loadScenarioHandler", () => {
  effect("a scenario on a scratch repo is ready to rehearse", () =>
    Effect.gen(function* () {
      const loaded = yield* loadScenarioHandler(request);
      expect([loaded.flow, loaded.enrolled, loaded.scenario.repo]).toEqual([
        "implement",
        false,
        "you/scratch",
      ]);
    }).pipe(Effect.provide(scenarios("you/scratch", Option.some("implement")))),
  );

  effect("one on an enrolled repo is refused, unless the person means it", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(loadScenarioHandler(request));
      expect(refused._tag).toBe("RehearsesEnrolledRepo");

      const meant = yield* loadScenarioHandler({ ...request, allowEnrolled: true });
      expect(meant.enrolled).toBe(true);
    }).pipe(Effect.provide(scenarios("you/app"))),
  );

  effect("one for another flow, or none at all, is invalid", () =>
    Effect.gen(function* () {
      const other = yield* Effect.flip(loadScenarioHandler(request));
      expect(other.message).toContain("rehearses review, not implement");

      const missing = yield* Effect.flip(loadScenarioHandler({ ...request, path: "/none.yaml" }));
      expect(missing.message).toContain("no such scenario file");
    }).pipe(Effect.provide(scenarios("you/scratch", Option.some("review")))),
  );
});
