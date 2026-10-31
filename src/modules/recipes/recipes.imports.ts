// What the recipes module takes from other modules: each one's grant, from its
// <module>.exports.ts and nowhere else of it. Only recipes' adapters dispatch
// these: its ACL adapters (infrastructure/acl/) and its inbound adapters
// (interface/) (docs/adr/0009-modules-import-and-export.md,
// docs/adr/0013-inbound-adapters-live-in-their-module.md).

// The checkout a path is in, which `recipes` acts on.
export { enrollmentAccessQueries } from "../enrollment/enrollment.exports.ts";
