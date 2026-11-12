import * as Schema from "effect/Schema";

// A GitHub App this machine acts as (#477, #481): its bot login, `<slug>[bot]`,
// and what machine config's github.<login>.token.app holds to make its
// installation tokens. `key` is the path to its private key file, as machine
// config writes it; the key itself is never in config.
export class AppPersona extends Schema.Class<AppPersona, { readonly brand: "AppPersona" }>(
  "AppPersona",
)({
  login: Schema.String,
  id: Schema.String,
  installation: Schema.String,
  key: Schema.String,
}) {}
