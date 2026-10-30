import * as Schema from "effect/Schema";

// What the service manager registered, or removed.
export class ServiceUnit extends Schema.Class<ServiceUnit, { readonly brand: "ServiceUnit" }>(
  "ServiceUnit",
)({
  path: Schema.String,
}) {}

// Whether the daemon is registered, as starting or stopping it returns it.
export { ServiceState } from "../domain/machine-setup/service-state.value-object.ts";
