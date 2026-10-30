import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { AccountDir } from "./inspect-account-dir.query.ts";

// What setting up the machine can choose: gh's logins and the personas
// chosen before, and the account directories in the home not set up yet.
export class SetupPlan extends Schema.Class<SetupPlan, { readonly brand: "SetupPlan" }>(
  "SetupPlan",
)({
  loggedIn: Schema.Array(Schema.String),
  personas: Schema.Array(Schema.String),
  // Whether machine config lists accounts yet.
  accountsWritten: Schema.Boolean,
  candidates: Schema.Array(AccountDir),
}) {}

// What setting up the machine can choose from: gh's logins, and the agents'
// account directories in the home that no account names yet.
export const PlanSetupQuery = Query.make("PlanSetupQuery", {
  success: SetupPlan,
  failure: PersistenceFailed,
});
