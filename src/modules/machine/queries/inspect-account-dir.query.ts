import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

// An account directory, in full and as the home spells it, and the agent its
// name says it's for, if it says.
export class AccountDir extends Schema.Class<AccountDir, { readonly brand: "AccountDir" }>(
  "AccountDir",
)({
  dir: Schema.String,
  display: Schema.String,
  agent: Schema.Option(Schema.String),
}) {}

// An account directory a person typed, ~ and all: where it is, and the agent
// its name says it's for, if it says.
export const InspectAccountDirQuery = Query.make("InspectAccountDirQuery", {
  payload: { typed: Schema.String },
  success: AccountDir,
});

export type InspectAccountDirPayload = Query.Payload<typeof InspectAccountDirQuery>;
