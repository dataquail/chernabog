import * as Schema from "effect/Schema";

// What the service manager registered, or removed.
export class ServiceUnit extends Schema.Class<ServiceUnit, { readonly brand: "ServiceUnit" }>(
  "ServiceUnit",
)({
  path: Schema.String,
}) {}

// Whether the daemon is registered with the service manager. Whether it's
// running is the daemon's to say, over its socket.
export class ServiceState extends Schema.Class<ServiceState, { readonly brand: "ServiceState" }>(
  "ServiceState",
)({
  installed: Schema.Boolean,
}) {}
