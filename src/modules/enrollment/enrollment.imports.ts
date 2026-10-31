// What the enrollment module takes from other modules: each one's grant, from
// its <module>.exports.ts and nowhere else of it. Only enrollment's adapters
// dispatch these: its ACL adapters (infrastructure/acl/) and its inbound
// adapters (interface/) (docs/adr/0009-modules-import-and-export.md,
// docs/adr/0013-inbound-adapters-live-in-their-module.md).

// The personas and accounts this machine offers, which `enroll` chooses among.
export { machineAccessQueries } from "../machine/machine.exports.ts";
// The team's config of a checkout, which the recipes module owns.
export { recipesAccessQueries } from "../recipes/recipes.exports.ts";
