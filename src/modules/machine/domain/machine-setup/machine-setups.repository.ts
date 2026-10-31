import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type PersistenceFailed } from "../../../../../kernel/persistence.errors.ts";
import { type MachineSetupRoot } from "../../machine-setup/machine-setup.root.ts";

// This machine's setup, of which there is one. `findOne` reads it as stored
// now, every time, since the daemon, the CLI and the person's editor all
// write machine config; `save` stores it.
export type MachineSetupsRepositoryService = {
  readonly findOne: Effect.Effect<MachineSetupRoot, PersistenceFailed>;
  readonly save: (setup: MachineSetupRoot) => Effect.Effect<void, PersistenceFailed>;
};

export class MachineSetupsRepository extends Context.Service<
  MachineSetupsRepository,
  MachineSetupsRepositoryService
>()("MachineSetupsRepository") {}
