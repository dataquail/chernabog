import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { renderTemplates, templatesRoot } from "../scripts/templates.ts";
import { effect } from "./effect-test.ts";

effect(
  "src/platform/templates.ts is what scripts/gen-templates.ts writes from templates/ (run it after changing a template)",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const generated = yield* fs.readFileString(
        yield* path.fromFileUrl(new URL("../src/platform/templates.ts", import.meta.url)),
      );

      expect(generated).toBe((yield* renderTemplates(templatesRoot)).text);
    }),
);

// The pre-commit hook (.husky/pre-commit) runs the checks AGENTS.md's “Before you finish” lists.
describe("the pre-commit hook", () => {
  const read = (file: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      return yield* fs.readFileString(
        yield* path.fromFileUrl(new URL(`../${file}`, import.meta.url)),
      );
    });

  const PackageJson = Schema.fromJsonString(
    Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) }),
  );

  const scripts = read("package.json").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PackageJson)),
    Effect.map((json) => json.scripts),
  );

  // The commands a script or a paragraph names, in order: `bun run <script>` and `bun test`.
  const commands = (text: string) =>
    [...text.matchAll(/(bun (?:run [\w:-]+|test))\s*(?:&&|\|\||`|$)/g)].map((match) => match[1]);

  effect("prepare installs husky, so `bun install` sets up the hook", () =>
    Effect.gen(function* () {
      expect((yield* scripts).prepare).toStartWith("husky && ");
    }),
  );

  effect(".husky/pre-commit runs the precommit script", () =>
    Effect.gen(function* () {
      expect(yield* read(".husky/pre-commit")).toContain("bun run precommit\n");
    }),
  );

  effect("precommit runs AGENTS.md's “Before you finish” checks, in its order", () =>
    Effect.gen(function* () {
      const precommit = (yield* scripts).precommit;
      const agents = yield* read("AGENTS.md");

      const section = agents
        .split("## Before you finish")[1]
        .split("\n## ")[0]
        .trim()
        .split("\n\n")[0];

      expect(commands(precommit)).toEqual(commands(section));
      expect(commands(precommit)).toEqual([
        "bun run format:check",
        "bun run check",
        "bun run lint",
        "bun run lint:architecture",
        "bun run test",
      ]);
    }),
  );

  effect("precommit says to run `bun run format` when format:check fails", () =>
    Effect.gen(function* () {
      expect((yield* scripts).precommit).toMatch(
        /^bun run format:check \|\| \{ echo '[^']*bun run format\b/,
      );
    }),
  );
});
