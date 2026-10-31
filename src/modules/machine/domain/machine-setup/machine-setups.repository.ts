import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type PersistenceFailed } from "../../../../kernel/persistence.errors.ts";
import { type Specification } from "../../../../kernel/specification.ts";
import { type MachineSetupRoot } from "./machine-setup.root.ts";

// This machine's setup, of which there is one. `findOne` reads it as stored
// now, every time, since the daemon, the CLI and the person's editor all
// write machine config; `upsertOne` stores it.
export type MachineSetupsRepositoryService = {
  readonly findOne: (
    spec: Specification<MachineSetupRoot>,
  ) => Effect.Effect<Option.Option<MachineSetupRoot>, PersistenceFailed>;
  readonly upsertOne: (setup: MachineSetupRoot) => Effect.Effect<void, PersistenceFailed>;
};

export class MachineSetupsRepository extends Context.Service<
  MachineSetupsRepository,
  MachineSetupsRepositoryService
>()("MachineSetupsRepository") {}
