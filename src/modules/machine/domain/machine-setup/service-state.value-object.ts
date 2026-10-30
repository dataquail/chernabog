import * as Schema from "effect/Schema";

// Whether the daemon is registered with the service manager. Whether it's
// running is the daemon's to say, over its socket.
export class ServiceState extends Schema.Class<ServiceState, { readonly brand: "ServiceState" }>(
  "ServiceState",
)({
  installed: Schema.Boolean,
}) {}
