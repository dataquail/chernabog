// The runs module's CLI endpoints, which the CLI's root registers as its
// subcommands (docs/adr/0013-inbound-adapters-live-in-their-module.md).

import { logsEndpoint } from "./logs.endpoint.ts";

export const runsEndpoints = {
  logs: logsEndpoint,
};

// Following a run's log until it finishes, which `run` does in the CLI's root
// after the daemon starts one.
export { followRunLog } from "./run-log.output.ts";
