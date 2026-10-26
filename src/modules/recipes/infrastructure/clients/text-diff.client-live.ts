// Two versions of a .chernabog/ file diffed by git, on copies in a scratch
// directory, so its headers read recipe/… and repo/…; and three merged by
// git merge-file, with markers labelled repo, copied and recipe.

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { Exec } from "../../../../platform/exec.ts";
import { TextDiffClient } from "../../domain/ports/clients/text-diff.client.ts";
import { RecipeFilesFailed } from "../../domain/recipe/recipe.errors.ts";

export const TextDiffClientLive = Layer.effect(
  TextDiffClient,
  Effect.gen(function* () {
    const services = yield* Effect.context<Exec | FileSystem.FileSystem>();

    const diff = (file: string, recipe: string, repo: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-recipe-diff-" });

          for (const [side, text] of [
            ["recipe", recipe],
            ["repo", repo],
          ] as const) {
            const path = `${scratch}/${side}/.chernabog/${file}`;
            yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true });
            yield* fs.writeFileString(path, text);
          }

          const result = yield* (yield* Exec).run(
            "git",
            [
              "diff",
              "--no-index",
              "--no-color",
              "--no-prefix",
              "--",
              `recipe/.chernabog/${file}`,
              `repo/.chernabog/${file}`,
            ],
            { cwd: scratch },
          );

          // git diff --no-index exits 1 when the files differ, 0 when they don't.
          if (result.exitCode > 1) {
            return yield* new RecipeFilesFailed({ message: `git diff: ${result.stderr.trim()}` });
          }

          return result.stdout.trimEnd();
        }),
      ).pipe(
        Effect.mapError((error) => new RecipeFilesFailed({ message: error.message })),
        Effect.provideContext(services),
      );

    const merge = (file: string, base: string, repo: string, recipe: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-recipe-merge-" });

          for (const [side, text] of [
            ["base", base],
            ["repo", repo],
            ["recipe", recipe],
          ] as const) {
            yield* fs.writeFileString(`${scratch}/${side}`, text);
          }

          const result = yield* (yield* Exec).run(
            "git",
            [
              "merge-file",
              "-p",
              "--diff3",
              "-L",
              `repo/.chernabog/${file}`,
              "-L",
              "copied",
              "-L",
              `recipe/.chernabog/${file}`,
              "repo",
              "base",
              "recipe",
            ],
            { cwd: scratch },
          );

          // git merge-file exits with the number of conflicts, and negative on an error.
          if (result.exitCode < 0 || result.exitCode > 127) {
            return yield* new RecipeFilesFailed({
              message: `git merge-file: ${result.stderr.trim()}`,
            });
          }

          return { text: result.stdout, conflicts: result.exitCode > 0 };
        }),
      ).pipe(
        Effect.mapError((error) => new RecipeFilesFailed({ message: error.message })),
        Effect.provideContext(services),
      );

    return TextDiffClient.of({ diff, merge });
  }),
);
