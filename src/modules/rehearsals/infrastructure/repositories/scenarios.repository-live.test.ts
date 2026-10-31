import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { ScenarioSpecifications } from "../../domain/scenario/scenario.specification.ts";
import { ScenariosRepository } from "../../domain/scenario/scenarios.repository.ts";
import { ScenariosRepositoryLive } from "./scenarios.repository-live.ts";

const SCENARIO = `repo: you/chernabog-rehearsal
flow: implement
install: null
localGate: ["true"]
given:
  issues:
    - name: bug
      title: The button does nothing
      labels: [auto:eligible]
agent:
  implement: { script: ./implement.sh }
  fix-ci-*: { fixture: { status: done, title: t, body: b, summary: s } }
expect:
  ends: done
  labels: [auto:needs-review]
`;

describe("ScenariosRepositoryLive", () => {
  effect("reads a scenario file, and knows where it is", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-scenario-" });
      yield* fs.writeFileString(`${dir}/implement.yaml`, SCENARIO);

      const scenario = Option.getOrThrow(
        yield* (yield* ScenariosRepository).findOne(
          ScenarioSpecifications.atPath(`${dir}/implement.yaml`),
        ),
      );

      expect(scenario.dir).toBe(dir);
      expect(scenario.repo).toBe("you/chernabog-rehearsal");
      expect(scenario.install).toEqual(Option.none());
      expect(scenario.given?.issues?.[0]?.labels).toEqual(["auto:eligible"]);
      expect(scenario.agent?.["fix-ci-*"]).toEqual({
        fixture: { status: "done", title: "t", body: "b", summary: "s" },
      });
      expect(scenario.expect).toEqual({ ends: "done", labels: ["auto:needs-review"] });
    }).pipe(Effect.provide(ScenariosRepositoryLive)),
  );

  effect("has none for a missing file, and refuses a key the schema doesn't know", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-scenario-" });
      yield* fs.writeFileString(`${dir}/typo.yaml`, "repo: you/scratch\nexpects: { ends: done }\n");
      const repository = yield* ScenariosRepository;

      expect(yield* repository.findOne(ScenarioSpecifications.atPath(`${dir}/none.yaml`))).toEqual(
        Option.none(),
      );

      const typo = yield* Effect.flip(
        repository.findOne(ScenarioSpecifications.atPath(`${dir}/typo.yaml`)),
      );

      expect(typo.message).toContain("expects");
    }).pipe(Effect.provide(ScenariosRepositoryLive)),
  );
});
