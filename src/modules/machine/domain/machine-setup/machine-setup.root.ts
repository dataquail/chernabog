import * as Schema from "effect/Schema";

import { MachineAccount } from "./machine-account.value-object.ts";

// Who this machine is on GitHub and whose AI budget its runs spend: the part
// of machine config `chernabog setup` chooses. A dumb value; its rules are
// MachineSetupRootOps.
export class MachineSetupRoot extends Schema.Class<
  MachineSetupRoot,
  { readonly brand: "MachineSetupRoot" }
>("MachineSetupRoot")({
  // The GitHub logins it acts as, under github:. None means the one implicit
  // persona: whoever GH_TOKEN, GITHUB_TOKEN or gh's active account is.
  personas: Schema.Array(Schema.String),
  accounts: Schema.Array(MachineAccount),
  // Whether machine config lists its accounts. Without accounts: it has the
  // one default, work, for claude, which repos may name.
  accountsWritten: Schema.Boolean,
}) {}
