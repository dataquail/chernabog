import * as Option from "effect/Option";

// A repo whose recipes an earlier chernabog baked has no recipe package to
// compare its flows with, until init installs @chernabog/recipes: the line
// that says so, when it has flows and no package; none otherwise.
export const noPackageHint = (packagesInstalled: boolean, flows: boolean) =>
  Option.toArray(
    Option.liftPredicate(
      "No recipe package is installed in .chernabog/, so none of its flows can be told from a recipe. If an earlier chernabog baked them, chernabog init installs @chernabog/recipes, keeping every file, and then chernabog recipes diff compares them.",
      () => !packagesInstalled && flows,
    ),
  );
