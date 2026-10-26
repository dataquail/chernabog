// The recipe package format: an npm package whose package.json has a
// `chernabog.recipes` key naming its recipes. @chernabog/recipes is one, and a
// company's own package is another, read the same way. Its files keep the
// layout of a repo's .chernabog/ (flows/, prompts/, stages/), so a copy lands
// at the same path, and an imported flow finds its prompts and steps where a
// copied one would.

import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import { RecipeRoot } from "./recipe.root.ts";

// The package a bare recipe name, such as `review`, means.
export const OFFICIAL_PACKAGE = "@chernabog/recipes";

const under = (folder: string, extension: string) =>
  Schema.String.pipe(
    Schema.check(
      Schema.isPattern(new RegExp(`^${folder}/[\\w.-]+${extension}$`), {
        message: `must be a file directly under ${folder}/`,
      }),
    ),
  );

// One recipe: its flow, the prompts it renders and the steps it runs, by path
// in the package.
export const RecipeManifest = Schema.Struct({
  // One line, for the list a person chooses from.
  description: Schema.String,
  flow: under("flows", "\\.(?:ts|js|mts|mjs)"),
  prompts: Schema.optionalKey(Schema.Array(under("prompts", "\\.md"))),
  stages: Schema.optionalKey(Schema.Array(under("stages", ""))),
  // Where the recipe is documented.
  docs: Schema.optionalKey(Schema.String),
});

export type RecipeManifest = typeof RecipeManifest.Type;

const RecipeName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][\w.-]*$/, { message: "must be a flow name" })),
);

// What chernabog reads of a recipe package's package.json.
export const RecipePackageManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  // The @chernabog/sdk versions its flows are written against.
  peerDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  chernabog: Schema.Struct({ recipes: Schema.Record(RecipeName, RecipeManifest) }),
});

export type RecipePackageManifest = typeof RecipePackageManifest.Type;

export const SDK_PACKAGE = "@chernabog/sdk";

// A recipe package as installed: its version, the SDK range it declares, and
// its recipes, in the order its package.json lists them.
export type RecipePackage = {
  readonly name: string;
  readonly version: string;
  readonly sdkRange: Option.Option<string>;
  readonly recipes: ReadonlyArray<RecipeRoot>;
};

export const recipePackageOf = (manifest: RecipePackageManifest): RecipePackage => ({
  name: manifest.name,
  version: manifest.version,
  sdkRange: Record.get(manifest.peerDependencies ?? {}, SDK_PACKAGE),
  recipes: Record.toEntries(manifest.chernabog.recipes).map(([name, recipe]) =>
    RecipeRoot.make({
      package: manifest.name,
      version: manifest.version,
      name,
      description: recipe.description,
      flow: recipe.flow,
      prompts: recipe.prompts ?? [],
      stages: recipe.stages ?? [],
      docs: Option.fromUndefinedOr(recipe.docs),
    }),
  ),
});

// A package's released versions, newest first, without prereleases: the
// order a version supporting the repo's SDK is looked for in.
export const newestFirst = (versions: ReadonlyArray<string>) =>
  versions
    .filter((version) => !version.includes("-"))
    .toSorted((left, right) => Bun.semver.order(right, left));

// Whether a package declaring this SDK range supports flows written against `sdk`.
export const supportsSdk = (sdkRange: Option.Option<string>, sdk: string) =>
  Option.exists(sdkRange, (range) => Bun.semver.satisfies(sdk, range));

// A recipe as a person names it: `<package>/<recipe>`, or a bare `<recipe>`
// from the official package. A scoped package keeps its scope:
// `@acme/chernabog-recipes/deploy`.
export type RecipeRef = { readonly package: string; readonly name: string };

export const parseRecipeRef = (text: string): RecipeRef => {
  const slash = text.lastIndexOf("/");

  return Option.match(
    Option.liftPredicate(slash, (at) => at > 0),
    {
      onNone: () => ({ package: OFFICIAL_PACKAGE, name: text }),
      onSome: (at) => ({ package: text.slice(0, at), name: text.slice(at + 1) }),
    },
  );
};

// How a recipe is named back to a person: bare for the official package.
export const formatRecipeRef = (ref: RecipeRef) =>
  Option.match(
    Option.liftPredicate(ref.package, (name) => name !== OFFICIAL_PACKAGE),
    {
      onNone: () => ref.name,
      onSome: (name) => `${name}/${ref.name}`,
    },
  );
