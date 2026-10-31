// The machine module's CLI endpoints, which the CLI's root registers as its
// subcommands (docs/adr/0013-inbound-adapters-live-in-their-module.md).

import { installEndpoint, stopEndpoint, uninstallEndpoint } from "./service.endpoint.ts";
import { setupEndpoint } from "./setup.endpoint.ts";

export const machineEndpoints = {
  setup: setupEndpoint,
  install: installEndpoint,
  uninstall: uninstallEndpoint,
  stop: stopEndpoint,
};
