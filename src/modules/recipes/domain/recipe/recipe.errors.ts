import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// A recipe named that this chernabog doesn't offer.
export class UnknownRecipe extends Schema.TaggedError<
  UnknownRecipe,
  { readonly brand: "UnknownRecipe" }
>()("UnknownRecipe", { recipe: Schema.String, known: Schema.Array(Schema.String) }) {
  public override get message() {
    const known = Option.getOrElse(
      Option.liftPredicate(this.known.join(", "), (names) => names.length > 0),
      () => "none",
    );

    return `no recipe named ${this.recipe} (there are: ${known})`;
  }
}

// A checkout's .chernabog/ couldn't be read or written, or diffed.
export class RecipeFilesFailed extends Schema.TaggedError<
  RecipeFilesFailed,
  { readonly brand: "RecipeFilesFailed" }
>()("RecipeFilesFailed", { message: Schema.String }) {}

// .chernabog/ needs another chernabog than this one, so it's left alone.
export class ScaffoldRefused extends Schema.TaggedError<
  ScaffoldRefused,
  { readonly brand: "ScaffoldRefused" }
>()("ScaffoldRefused", { message: Schema.String }) {}

// A recipe named from a package that isn't installed in the repo's .chernabog/.
export class RecipePackageMissing extends Schema.TaggedError<
  RecipePackageMissing,
  { readonly brand: "RecipePackageMissing" }
>()("RecipePackageMissing", { package: Schema.String }) {
  public override get message() {
    return `${this.package} isn't installed in .chernabog/; install it there with bun add -d ${this.package}, and commit package.json and bun.lock`;
  }
}

// A recipe package couldn't be found, chosen or installed: offline, a
// registry that refused, or no version for the repo's SDK.
export class RecipePackageUnavailable extends Schema.TaggedError<
  RecipePackageUnavailable,
  { readonly brand: "RecipePackageUnavailable" }
>()("RecipePackageUnavailable", { package: Schema.String, message: Schema.String }) {}
