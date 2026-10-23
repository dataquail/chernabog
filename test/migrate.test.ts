import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { migrateMachineConfig } from "../src/migrate.ts";
import { githubTestLayer } from "../src/platform/github-api.ts";
import { Home, homePaths } from "../src/platform/home.ts";
import { effectAtHomeWith } from "./effect-test.ts";

// The migration asks GitHub nothing for these entries.
const effectAtHome = effectAtHomeWith(githubTestLayer(() => Option.none()));

const CONFIG =
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
