import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";

// The personas a machine acts as and the accounts it spends, for choosing a
// repo's.
export class MachineSetupView extends Schema.Class<
  MachineSetupView,
  { readonly brand: "MachineSetupView" }
>("MachineSetupView")({
  personas: Schema.Array(Schema.String),
  accounts: Schema.Array(Schema.Struct({ name: Schema.String, agent: Schema.String })),
}) {}

// The personas this machine acts as and the accounts it spends. Without
// accounts: it has the one default, work, for claude.
export const ReadMachineSetupQuery = Query.make("ReadMachineSetupQuery", {
  success: MachineSetupView,
  failure: PersistenceFailed,
});
