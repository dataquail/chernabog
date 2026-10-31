// What the enrollment module takes from other modules: each one's grant, from
// its <module>.exports.ts and nowhere else of it. Only enrollment's ACL
// adapters (infrastructure/acl/) dispatch these
// (docs/adr/0013-modules-import-and-export.md).

// The team's config of a checkout, which the recipes module owns.
export { recipesAccessQueries } from "../recipes/recipes.exports.ts";
