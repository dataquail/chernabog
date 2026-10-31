import * as Layer from "effect/Layer";

import { ConfigTreeClientLive } from "./infrastructure/clients/config-tree.client-live.ts";
import { ReloadsRepositoryLive } from "./infrastructure/repositories/reloads.repository-live.ts";
import { TrustRecordsRepositoryLive } from "./infrastructure/repositories/trust-records.repository-live.ts";
import { TrustCommandsLive } from "./trust.command-handlers.ts";
import { TrustQueriesLive } from "./trust.query-handlers.ts";

// The trust module, wired: its dispatchers over the live adapters its handlers
// need. What still differs between composition roots (the platform, GitHub, the
// bus its commands dispatch on) stays in its requirements, for each root to
// provide.
export const TrustModule = {
  layer: Layer.mergeAll(TrustCommandsLive, TrustQueriesLive).pipe(
    Layer.provide(
      Layer.mergeAll(TrustRecordsRepositoryLive, ReloadsRepositoryLive, ConfigTreeClientLive),
    ),
  ),
};
