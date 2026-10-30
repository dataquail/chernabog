// fddh's local rules that hold in any repo, vendored from
// dataquail/functional-domain-driven-hexagon scripts/lint-rules/, and this
// repo's own (no-recipe-names), addressed as `local/<rule>`.
import noArrayPushSpread from "./no-array-push-spread.mjs";
import noRecipeNames from "./no-recipe-names.mjs";
import noRelativeImportOutsidePackage from "./no-relative-import-outside-package.mjs";

export const rules = {
  "no-array-push-spread": noArrayPushSpread,
  "no-recipe-names": noRecipeNames,
  "no-relative-import-outside-package": noRelativeImportOutsidePackage,
};

export default { meta: { name: "local" }, rules };
