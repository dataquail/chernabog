import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { effect } from "../../../../test/effect-test.ts";
import { ScenariosRepositoryLive } from "../infrastructure/repositories/scenarios.repository-live.ts";
import { loadScenarioHandler } from "./load-scenario.handler.ts";

// A scenario file in a scratch checkout's .chernabog/rehearsals/, as a person
// would write it, and a request to rehearse the implement flow with it.
const scenario = (text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-rehearsal-" });
    const dir = `${root}/.chernabog/rehearsals`;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${dir}/implement.yaml`, text);

    return {
      root,
      request: {
        path: `${dir}/implement.yaml`,
        flow: "implement",
        enrolled: ["you/app"],
        allowEnrolled: false,
      },
    };
  });

describe("loadScenarioHandler", () => {
  effect("a scenario on a scratch repo is ready to rehearse", () =>
    Effect.gen(function* () {
      const { request } = yield* scenario("repo: you/scratch\nflow: implement\n");

      const loaded = yield* loadScenarioHandler(request);
      expect([loaded.flow, loaded.enrolled, loaded.scenario.repo]).toEqual([
        "implement",
        false,
        "you/scratch",
      ]);
    }).pipe(Effect.provide(ScenariosRepositoryLive)),
  );

  effect("one on an enrolled repo is refused, unless the person means it", () =>
    Effect.gen(function* () {
      const { request } = yield* scenario("repo: you/app\n");

      const refused = yield* Effect.flip(loadScenarioHandler(request));
      expect(refused._tag).toBe("RehearsesEnrolledRepo");

      const meant = yield* loadScenarioHandler({ ...request, allowEnrolled: true });
      expect(meant.enrolled).toBe(true);
    }).pipe(Effect.provide(ScenariosRepositoryLive)),
  );

  effect("one for another flow, or none at all, is invalid", () =>
    Effect.gen(function* () {
      const { request, root } = yield* scenario("repo: you/scratch\nflow: review\n");

      const other = yield* Effect.flip(loadScenarioHandler(request));
      expect(other.message).toContain("rehearses review, not implement");

      const missing = yield* Effect.flip(
        loadScenarioHandler({ ...request, path: `${root}/none.yaml` }),
      );

      expect(missing.message).toContain("no such scenario file");
    }).pipe(Effect.provide(ScenariosRepositoryLive)),
  );
});
