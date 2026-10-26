import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { FlowImportsRepository } from "../../domain/ports/repositories/flow-imports.repository.ts";
import { FlowImportsRepositoryLive } from "./flow-imports.repository-live.ts";

const CONFIG = `# The team's config.
flows:
  # Reviews by the pool.
  review:
    from: "@chernabog/recipes/review"
    enabled: false
  deploy:
    from: "@acme/recipes/deploy"
  implement:
    runners: [alice]
`;

describe("FlowImportsRepositoryLive", () => {
  effect("reads each flow's from, and sets and removes one keeping comments and other keys", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const imports = yield* FlowImportsRepository;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-imports-" });
      yield* fs.makeDirectory(`${root}/.chernabog`);
      yield* fs.writeFileString(`${root}/.chernabog/config.yaml`, CONFIG);

      expect([...(yield* imports.findAll(root))]).toEqual([
        ["review", "@chernabog/recipes/review"],
        ["deploy", "@acme/recipes/deploy"],
      ]);

      yield* imports.save(root, "review", Option.none());
      yield* imports.save(root, "deploy", Option.none());
      yield* imports.save(root, "resolve-conflicts", Option.some("resolve-conflicts"));

      const written = yield* fs.readFileString(`${root}/.chernabog/config.yaml`);
      expect(written).toContain("# Reviews by the pool.\n  review:\n    enabled: false");
      expect(written).not.toContain("deploy");
      expect(written).toContain("runners: [ alice ]");
      expect([...(yield* imports.findAll(root))]).toEqual([
        ["resolve-conflicts", "resolve-conflicts"],
      ]);
    }).pipe(Effect.provide(FlowImportsRepositoryLive)),
  );
});
