import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ChernabogDirClient } from "../domain/ports/clients/chernabog-dir.client.ts";
import { RecipePackagesClient } from "../domain/ports/clients/recipe-packages.client.ts";
import { RecipeFilesFailed } from "../domain/recipe/recipe.errors.ts";
import { RecipeRootOps } from "../domain/recipe/recipe.root-ops.ts";
import { type CopiedRecord, withCopied } from "../domain/recipe/repo-manifest.value-object.ts";
import { RecipesAdded } from "./recipe.result.ts";

const MANIFEST = ".chernabog/package.json";

// Copies the recipes a person names, from the packages installed in the
// repo's .chernabog/, into the repo at `root`, never overwriting a file that
// is there: a flow of that name is the repo's own, and a prompt another
// recipe brought is shared. Each file written is recorded in package.json with
// the package version it came from. A name that isn't a recipe is refused
// before anything is written.
export const addRecipesUseCase = Effect.fn("addRecipesUseCase")(function* (
  root: string,
  names: ReadonlyArray<string>,
) {
  const dir = yield* ChernabogDirClient;
  const packages = yield* RecipePackagesClient;

  if (names.length === 0) {
    return RecipesAdded.make({ files: [] });
  }

  yield* packages.restore(root);

  const recipes = yield* Effect.fromResult(
    RecipeRootOps.allNamed(yield* packages.installed(root), names),
  );

  const files: Array<(typeof RecipesAdded.Type.files)[number]> = [];
  const records: Record<string, Option.Option<CopiedRecord>> = {};

  for (const recipe of recipes) {
    const ref = RecipeRootOps.refOf(recipe);

    for (const file of RecipeRootOps.filesOf(recipe)) {
      const path = `.chernabog/${file}`;

      if (Option.isSome(yield* dir.read(root, path))) {
        if (file === RecipeRootOps.flowFileOf(recipe)) {
          files.push({ file: path, recipe: ref, version: recipe.version, outcome: "kept" });
        }

        continue;
      }

      const text = yield* Effect.fromOption(yield* packages.file(root, recipe.package, file)).pipe(
        Effect.mapError(
          () =>
            new RecipeFilesFailed({
              message: `${recipe.package}@${recipe.version} names ${file} for ${recipe.name}, and hasn't it`,
            }),
        ),
      );

      yield* dir.write(root, path, text);
      records[file] = Option.some({
        from: `${recipe.package}/${recipe.name}`,
        version: recipe.version,
      });
      files.push({ file: path, recipe: ref, version: recipe.version, outcome: "wrote" });
    }
  }

  if (Object.keys(records).length > 0) {
    const manifest = Option.getOrElse(yield* dir.read(root, MANIFEST), () => "{}\n");
    yield* dir.write(root, MANIFEST, yield* Effect.fromResult(withCopied(manifest, records)));
  }

  return RecipesAdded.make({ files });
});
