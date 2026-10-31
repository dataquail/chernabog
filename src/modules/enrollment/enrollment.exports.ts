// The enrollment module's PEER surface: what another module may ask of it,
// each grant named for its kind. A peer reaches it only from its own
// <module>.imports.ts, and dispatches it only from an ACL adapter or an inbound
// adapter of its own (docs/adr/0013-modules-import-and-export.md,
// docs/adr/0014-inbound-adapters-live-in-their-module.md). Publish nothing here
// without a consumer.

import { Query } from "@effect-server-utils/cqrs";

import { enrollmentQueryGroup } from "./enrollment.query-handlers.ts";

// The checkout a path is in, which `recipes` acts on; the enrolled repos a
// person names, which `trust` trusts; and the personas the enrolled repos run
// as, which `setup` keeps.
export const enrollmentAccessQueries = Query.subsetOf(
  enrollmentQueryGroup,
  "FindCheckoutRootQuery",
  "ListEnrolledReposQuery",
  "ListPersonasInUseQuery",
);
