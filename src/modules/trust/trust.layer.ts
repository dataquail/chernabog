import * as Layer from "effect/Layer";

import { ConfigTreeClientLive } from "./infrastructure/clients/config-tree.client-live.ts";
import { ReloadsRepositoryLive } from "./infrastructure/repositories/reloads.repository-live.ts";
import { TrustRecordsRepositoryLive } from "./infrastructure/repositories/trust-records.repository-live.ts";

// The trust module's live adapters, for a composition root to provide.
export const TrustLayer = Layer.mergeAll(
  TrustRecordsRepositoryLive,
  ReloadsRepositoryLive,
  ConfigTreeClientLive,
);
