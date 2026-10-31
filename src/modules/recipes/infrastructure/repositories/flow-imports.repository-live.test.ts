import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";

import { effect } from "../../../../../test/effect-test.ts";
import { Spec } from "../../../../kernel/specification.ts";
import { FlowImportRoot } from "../../domain/flow-import/flow-import.root.ts";
import { FlowImportSpecifications } from "../../domain/flow-import/flow-import.specification.ts";
import { FlowImportsRepository } from "../../domain/flow-import/flow-imports.repository.ts";
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
      const inCheckout = FlowImportSpecifications.inCheckout(root);
      const imported = (flow: string, from: string) => FlowImportRoot.make({ root, flow, from });

      expect(yield* imports.findMany(inCheckout)).toEqual([
        imported("review", "@chernabog/recipes/review"),
        imported("deploy", "@acme/recipes/deploy"),
      ]);
      expect(
        yield* imports.findMany(Spec.and(inCheckout, FlowImportSpecifications.forFlow("deploy"))),
      ).toEqual([imported("deploy", "@acme/recipes/deploy")]);

      yield* imports.deleteOne(imported("review", "@chernabog/recipes/review"));
      yield* imports.deleteOne(imported("deploy", "@acme/recipes/deploy"));
      yield* imports.upsertOne(imported("resolve-conflicts", "resolve-conflicts"));

      const written = yield* fs.readFileString(`${root}/.chernabog/config.yaml`);
      expect(written).toContain("# Reviews by the pool.\n  review:\n    enabled: false");
      expect(written).not.toContain("deploy");
      expect(written).toContain("runners: [ alice ]");
      expect(yield* imports.findMany(inCheckout)).toEqual([
        imported("resolve-conflicts", "resolve-conflicts"),
      ]);
    }).pipe(Effect.provide(FlowImportsRepositoryLive)),
  );

  effect("refuses a read that names no checkout, as a bug in its caller", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        (yield* FlowImportsRepository).findMany(FlowImportSpecifications.forFlow("review")),
      );

      expect(Exit.hasDies(exit)).toBe(true);
    }).pipe(Effect.provide(FlowImportsRepositoryLive)),
  );
});
