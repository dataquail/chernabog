import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type RecipeFilesFailed } from "../../recipe/recipe.errors.ts";

// The files of a checkout at `root`, by path under it, such as
// .chernabog/flows/review.ts or .gitignore.
export type ChernabogDirClientService = {
  // A file's text; none when it isn't there.
  readonly read: (
    root: string,
    path: string,
  ) => Effect.Effect<Option.Option<string>, RecipeFilesFailed>;
  // Writes a file, making its directory first.
  readonly write: (
    root: string,
    path: string,
    text: string,
  ) => Effect.Effect<void, RecipeFilesFailed>;
  readonly append: (
    root: string,
    path: string,
    text: string,
  ) => Effect.Effect<void, RecipeFilesFailed>;
  // The names in a directory, sorted; none when it isn't there.
  readonly list: (root: string, path: string) => Effect.Effect<ReadonlyArray<string>>;
};

export class ChernabogDirClient extends Context.Service<
  ChernabogDirClient,
  ChernabogDirClientService
>()("ChernabogDirClient") {}
