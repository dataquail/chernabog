// The recipes module's PEER surface: what another module may ask of it, each
// grant named for its kind. A peer reaches it only from its own
// <module>.imports.ts, and dispatches it only from an ACL adapter
// (docs/adr/0013-modules-import-and-export.md). Publish nothing here without a
// consumer.

import { Query } from "@effect-server-utils/cqrs";

import { recipesQueryGroup } from "./recipes.query-handlers.ts";

// Enrollment asks the team's config of a checkout, for the defaults enrolling
// offers (enrollment's TeamFlowsAcl).
export const recipesAccessQueries = Query.subsetOf(recipesQueryGroup, "ReadTeamConfigQuery");
