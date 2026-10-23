import * as Schema from "effect/Schema";

// An AI account this machine's runs spend: a login of one agent, kept in a
// config directory. Machine config names it, and says which agent it's for
// when that isn't claude.
export class MachineAccount extends Schema.Class<
  MachineAccount,
  { readonly brand: "MachineAccount" }
>("MachineAccount")({
  name: Schema.String,
  agent: Schema.String,
  // As machine config writes it, such as ~/.claude-personal; none for the
  // agent's own default directory.
  configDir: Schema.Option(Schema.String),
}) {}
