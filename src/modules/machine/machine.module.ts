import * as Layer from "effect/Layer";

import { AccountDirsClientLive } from "./infrastructure/clients/account-dirs.client-live.ts";
import { GitHubLoginsClientLive } from "./infrastructure/clients/github-logins.client-live.ts";
import { ServiceManagerClientLive } from "./infrastructure/clients/service-manager.client-live.ts";
import { MachineSetupsRepositoryLive } from "./infrastructure/repositories/machine-setups.repository-live.ts";
import { MachineCommandsLive } from "./machine.command-handlers.ts";
import { MachineQueriesLive } from "./machine.query-handlers.ts";

// The machine module, wired: its dispatchers over the live adapters its handlers
// need. What still differs between composition roots (the platform, GitHub, the
// bus its commands dispatch on) stays in its requirements, for each root to
// provide.
export const MachineModule = {
  layer: Layer.mergeAll(MachineCommandsLive, MachineQueriesLive).pipe(
    Layer.provide(
      Layer.mergeAll(
        MachineSetupsRepositoryLive,
        GitHubLoginsClientLive,
        AccountDirsClientLive,
        ServiceManagerClientLive,
      ),
    ),
  ),
};
