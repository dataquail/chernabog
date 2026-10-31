import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { effect } from "../../../../test/effect-test.ts";
import { BundleClientFake } from "../infrastructure/clients/bundle.client-fake.ts";
import { ChernabogDirClientFake } from "../infrastructure/clients/chernabog-dir.client-fake.ts";
import { TextDiffClientFake } from "../infrastructure/clients/text-diff.client-fake.ts";
import { scaffoldRepoHandler } from "./scaffold-repo.handler.ts";

const SCAFFOLD = {
  files: { "config.yaml": "flows: {}\n", "config.schema.json": "{ schema }\n" },
  generated: ["config.schema.json"],
  manifest: "{ }\n",
};

// A checkout at /repo holding `files`, by path under it.
const repoWith = (files: Record<string, string>) => {
  const stored: Record<string, string> = Object.fromEntries(
    Object.entries(files).map(([path, text]) => [`/repo/${path}`, text]),
  );

  return {
    stored,
    layer: Layer.mergeAll(
      ChernabogDirClientFake(stored),
      BundleClientFake(SCAFFOLD),
      TextDiffClientFake,
    ),
  };
};

describe("scaffoldRepoHandler", () => {
  const fresh = repoWith({ ".gitignore": "dist" });

  effect("writes the scaffold and its manifest, and gitignores what .chernabog/ installs", () =>
    Effect.gen(function* () {
      const { changes } = yield* scaffoldRepoHandler({ root: "/repo" });

      expect(changes.map((change) => [change.path, change.change])).toEqual([
        [".chernabog/config.yaml", "written"],
        [".chernabog/config.schema.json", "written"],
        [".chernabog/package.json", "written"],
        [".gitignore", "ignored"],
      ]);
      expect(fresh.stored["/repo/.gitignore"]).toBe("dist\n.chernabog/node_modules/\n");
    }).pipe(Effect.provide([fresh.layer, PassThroughUnitOfWork])),
  );

  const stale = repoWith({
    ".chernabog/config.yaml": "mine\n",
    ".chernabog/config.schema.json": "{ old }\n",
    ".chernabog/package.json": '{ "pinned" }\n',
    ".gitignore": "node_modules\n",
  });

  effect("updates a stale generated schema, and keeps the rest, pins included", () =>
    Effect.gen(function* () {
      const { changes } = yield* scaffoldRepoHandler({ root: "/repo" });

      expect(changes.map((change) => [change.path, change.change])).toEqual([
        [".chernabog/config.schema.json", "updated"],
      ]);
      expect(stale.stored["/repo/.chernabog/config.yaml"]).toBe("mine\n");
      expect(stale.stored["/repo/.chernabog/package.json"]).toBe('{ "pinned" }\n');
    }).pipe(Effect.provide([stale.layer, PassThroughUnitOfWork])),
  );

  const tooNew = repoWith({ ".chernabog/package.json": '{ "too new" }\n' });

  effect("refuses a .chernabog/ written against a newer SDK, writing nothing", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(scaffoldRepoHandler({ root: "/repo" }));

      expect(refused._tag).toBe("ScaffoldRefused");
      expect(Object.keys(tooNew.stored)).toEqual(["/repo/.chernabog/package.json"]);
    }).pipe(Effect.provide([tooNew.layer, PassThroughUnitOfWork])),
  );

  const withFlows = {
    stored: { "/repo/.chernabog/config.schema.json": "{ old }\n" },
    scaffold: { ...SCAFFOLD, files: { ...SCAFFOLD.files, "config.schema.json": "{flows}\n" } },
  };

  effect("writes config.schema.json describing the settings the repo's own flows declare", () =>
    Effect.gen(function* () {
      yield* scaffoldRepoHandler({ root: "/repo" });

      expect(withFlows.stored["/repo/.chernabog/config.schema.json"]).toBe("{flows of /repo}\n");
    }).pipe(
      Effect.provide([
        Layer.mergeAll(
          ChernabogDirClientFake(withFlows.stored),
          BundleClientFake(withFlows.scaffold),
          TextDiffClientFake,
        ),
        PassThroughUnitOfWork,
      ]),
    ),
  );
});
