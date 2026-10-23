import * as Layer from "effect/Layer";

import { AccountDirsClientLive } from "./infrastructure/clients/account-dirs.client-live.ts";
import { GitHubLoginsClientLive } from "./infrastructure/clients/github-logins.client-live.ts";
import { ServiceManagerClientLive } from "./infrastructure/clients/service-manager.client-live.ts";
import { MachineSetupsRepositoryLive } from "./infrastructure/repositories/machine-setups.repository-live.ts";

// The machine module's live adapters, for a composition root to provide.
export const MachineLayer = Layer.mergeAll(
  MachineSetupsRepositoryLive,
  GitHubLoginsClientLive,
  AccountDirsClientLive,
  ServiceManagerClientLive,
);
