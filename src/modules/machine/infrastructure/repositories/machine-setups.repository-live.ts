// A machine's setup in machine config (~/.config/chernabog/config.yaml), which
// a person edits by hand. Read afresh every time; saved by editing github:
// and accounts: in place, keeping the file's comments and every other key.

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { Home, homePaths } from "../../../../config.ts";
import { PersistenceFailed } from "../../../../kernel/persistence.errors.ts";
import { editMachineConfig, MachineConfigFile, readYaml } from "../../../../repo-config.ts";
import { type MachineSetupRoot } from "../../domain/machine-setup/machine-setup.root.ts";
import { MachineSetupsRepository } from "../../domain/ports/repositories/machine-setups.repository.ts";
import { applySetup, toRoot } from "./machine-setup.mapper.ts";

const failed = (error: { readonly message: string }) =>
  new PersistenceFailed({ message: error.message });

export const MachineSetupsRepositoryLive = Layer.effect(
  MachineSetupsRepository,
  Effect.gen(function* () {
    const services = yield* Effect.context<FileSystem.FileSystem | Home>();
    const file = homePaths((yield* Home).root).machineConfig;

    const findOne = readYaml(MachineConfigFile, file).pipe(
      Effect.map(toRoot),
      Effect.mapError(failed),
      Effect.provideContext(services),
    );

    const save = (setup: MachineSetupRoot) =>
      editMachineConfig((document, current) =>
        Effect.sync(() => {
          applySetup(document, toRoot(current), setup);
        }),
      ).pipe(Effect.mapError(failed), Effect.provideContext(services));

    return MachineSetupsRepository.of({ findOne, save });
  }),
);
