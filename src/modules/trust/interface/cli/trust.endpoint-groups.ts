// The trust module's CLI endpoints, which the CLI's root registers as its
// subcommands (docs/adr/0014-inbound-adapters-live-in-their-module.md).

import { trustEndpoint } from "./trust.endpoint.ts";

export const trustEndpoints = {
  trust: trustEndpoint,
};
