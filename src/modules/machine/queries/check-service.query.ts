import { Query } from "@effect-server-utils/cqrs";

import { ServiceState } from "../domain/machine-setup/service-state.value-object.ts";

// Whether the daemon is installed as a service.
export const CheckServiceQuery = Query.make("CheckServiceQuery", {
  success: ServiceState,
});
