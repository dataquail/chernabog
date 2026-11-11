import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type PersistenceFailed } from "../../../../../kernel/persistence.errors.ts";

// Where this machine keeps its GitHub Apps' private keys: one file each,
// readable only by the person, under the home's keys/. Paths are as machine
// config writes them, with ~ for the person's home.
export type AppKeysClientService = {
  // Writes an App's key, replacing one there, and says where it is.
  readonly write: (slug: string, privateKey: string) => Effect.Effect<string, PersistenceFailed>;
  readonly read: (path: string) => Effect.Effect<string, PersistenceFailed>;
};

export class AppKeysClient extends Context.Service<AppKeysClient, AppKeysClientService>()(
  "AppKeysClient",
) {}
