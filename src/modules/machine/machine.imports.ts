// What the machine module takes from other modules: each one's grant, from its
// <module>.exports.ts and nowhere else of it. Only machine's adapters dispatch
// these: its ACL adapters (infrastructure/acl/) and its inbound adapters
// (interface/) (docs/adr/0009-modules-import-and-export.md,
// docs/adr/0013-inbound-adapters-live-in-their-module.md).

// The personas the enrolled repos run as, which `setup` keeps.
export { enrollmentAccessQueries } from "../enrollment/enrollment.exports.ts";
