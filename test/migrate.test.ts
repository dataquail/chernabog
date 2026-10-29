import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { migrateMachineConfig } from "../src/migrate.ts";
import { githubTestLayer } from "../src/platform/github-api.ts";
import { Home, homePaths } from "../src/platform/home.ts";
import { VERSION } from "../src/platform/version.ts";
import { loadMachineConfig } from "../src/repo-config.ts";
import { effectAtHomeWith } from "./effect-test.ts";

// The migration asks GitHub nothing for these entries.
const effectAtHome = effectAtHomeWith(githubTestLayer(() => Option.none()));

const CONFIG =
  `chernabog: ${VERSION}\n` +
  "repos:\n  - repo: dataquail/demo\n    path: /src/demo\n    flows: {}\n  - repo: dataquail/widgets\n    name: widgets-2\n    path: /src/widgets\n    flows: {}\n";

const withPaused = (paused: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = homePaths((yield* Home).root);
    yield* fs.writeFileString(paths.machineConfig, CONFIG);
    yield* fs.writeFileString(paths.paused, paused);

    return { lines: yield* migrateMachineConfig, paused: () => fs.readFileString(paths.paused) };
  });

describe("migrating paused.json", () => {
  effectAtHome("keeps paused repos by slug rather than name, saying what moved", () =>
    Effect.gen(function* () {
      const { lines, paused } = yield* withPaused('["demo","gone","widgets-2"]\n');

      expect(lines).toEqual([
        "paused.json now keeps paused repos by owner/name: demo → dataquail/demo, gone → not enrolled, dropped, widgets-2 → dataquail/widgets",
      ]);
      expect(yield* paused()).toBe('["dataquail/demo","dataquail/widgets"]\n');
    }),
  );

  effectAtHome("changes nothing once it is keyed by slug", () =>
    Effect.gen(function* () {
      const { lines, paused } = yield* withPaused('["dataquail/demo"]\n');

      expect(lines).toEqual([]);
      expect(yield* paused()).toBe('["dataquail/demo"]\n');
    }),
  );
});

describe("stamping machine config", () => {
  const UNSTAMPED = "# mine\nrepos: []\n";

  const at = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = (yield* Home).root;

    return { fs, root, paths: homePaths(root) };
  });

  effectAtHome("stamps it with this chernabog, keeping a copy of it as it was", () =>
    Effect.gen(function* () {
      const { fs, paths } = yield* at;
      yield* fs.writeFileString(paths.machineConfig, UNSTAMPED);
      const copy = `${paths.backups}/config.yaml.before-${VERSION}`;

      expect(yield* migrateMachineConfig).toEqual([
        `stamped chernabog ${VERSION}; a copy of it as it was is at ${copy}`,
      ]);
      expect(yield* fs.readFileString(copy)).toBe(UNSTAMPED);
      expect(yield* fs.readFileString(paths.machineConfig)).toBe(
        `# The chernabog that last migrated this file. An older one won't read it.\nchernabog: ${VERSION}\n# mine\nrepos: []\n`,
      );
      expect(yield* migrateMachineConfig).toEqual([]);
    }),
  );

  effectAtHome("moves an older stamp up, keeping the copy under the version it came from", () =>
    Effect.gen(function* () {
      const { fs, paths } = yield* at;
      yield* fs.writeFileString(paths.machineConfig, "chernabog: 0.0.1\nrepos: []\n");

      expect(yield* migrateMachineConfig).toEqual([
        `moved from chernabog 0.0.1 to chernabog ${VERSION}; a copy of it as it was is at ${paths.backups}/config.yaml.0.0.1`,
      ]);
      expect(yield* fs.readFileString(paths.machineConfig)).toBe(
        `chernabog: ${VERSION}\nrepos: []\n`,
      );
    }),
  );

  effectAtHome("keeps the newest three copies", () =>
    Effect.gen(function* () {
      const { fs, paths } = yield* at;

      for (const [index, version] of ["0.0.1", "0.0.2", "0.0.3", "0.0.4"].entries()) {
        yield* fs.writeFileString(paths.machineConfig, `chernabog: ${version}\nrepos: []\n`);
        yield* migrateMachineConfig;
        // Made a day apart, as upgrades are.
        const made = 1_767_225_600 + index * 86_400;
        yield* fs.utimes(`${paths.backups}/config.yaml.${version}`, made, made);
      }

      expect((yield* fs.readDirectory(paths.backups)).toSorted()).toEqual([
        "config.yaml.0.0.2",
        "config.yaml.0.0.3",
        "config.yaml.0.0.4",
      ]);
    }),
  );

  effectAtHome(
    "a newer chernabog's file is left alone and refused, saying how to restore this one's copy",
    () =>
      Effect.gen(function* () {
        const { fs, paths } = yield* at;
        const newer = "chernabog: 99.0.0\nrepos: []\n";
        yield* fs.writeFileString(paths.machineConfig, newer);

        expect(yield* migrateMachineConfig).toEqual([]);
        expect(yield* fs.readFileString(paths.machineConfig)).toBe(newer);

        const refused = yield* Effect.result(loadMachineConfig);
        expect(Result.isFailure(refused) && refused.failure.message).toBe(
          `machine config was last migrated by chernabog 99.0.0, newer than this ${VERSION}, so this chernabog won't read it. Upgrade chernabog, or there's no copy of it from ${VERSION} in ${paths.backups} to roll back to`,
        );

        // What the newer chernabog left when it moved this one's file up.
        const copy = `${paths.backups}/config.yaml.${VERSION}`;
        yield* fs.makeDirectory(paths.backups, { recursive: true });
        yield* fs.writeFileString(copy, `chernabog: ${VERSION}\nconcurrency: 2\n`);

        const named = yield* Effect.result(loadMachineConfig);
        expect(Result.isFailure(named) && named.failure.message).toContain(
          `restore the copy kept for ${VERSION} with cp ${copy} ${paths.machineConfig}`,
        );

        yield* fs.copyFile(copy, paths.machineConfig);
        expect((yield* loadMachineConfig).concurrency).toBe(2);
      }),
  );
});

describe("dropping a repo's baseBranch", () => {
  effectAtHome("removes it, since .chernabog/ is read from GitHub's default branch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = homePaths((yield* Home).root);
      yield* fs.writeFileString(
        paths.machineConfig,
        `chernabog: ${VERSION}\nrepos:\n  - repo: dataquail/demo\n    path: /src/demo\n    baseBranch: trunk\n    flows: {}\n`,
      );

      expect(yield* migrateMachineConfig).toEqual([
        "dataquail/demo: baseBranch is gone; .chernabog/ is read from GitHub's default branch, and a flow's base setting names the branch its work targets",
      ]);
      expect(yield* fs.readFileString(paths.machineConfig)).toBe(
        `chernabog: ${VERSION}\nrepos:\n  - repo: dataquail/demo\n    path: /src/demo\n    flows: {}\n`,
      );
      expect(yield* migrateMachineConfig).toEqual([]);
    }),
  );
});
