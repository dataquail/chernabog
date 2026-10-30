import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";

// The GitHub logins enrolled repos run as, by their own entries, which the
// machine must keep acting as.
export class PersonasInUse extends Schema.Class<PersonasInUse, { readonly brand: "PersonasInUse" }>(
  "PersonasInUse",
)({
  logins: Schema.Array(Schema.String),
}) {}

// The logins enrolled repos run as, each once: setting up the machine can't
// drop one without stranding a repo.
export const ListPersonasInUseQuery = Query.make("ListPersonasInUseQuery", {
  success: PersonasInUse,
  failure: PersistenceFailed,
});
