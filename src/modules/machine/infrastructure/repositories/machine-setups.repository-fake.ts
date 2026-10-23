import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { type MachineSetupRoot } from "../../domain/machine-setup/machine-setup.root.ts";
import { MachineSetupsRepository } from "../../domain/ports/repositories/machine-setups.repository.ts";

// A machine's setup in memory, starting from `setup`.
export const MachineSetupsRepositoryFake = (setup: MachineSetupRoot) =>
  Layer.effect(
    MachineSetupsRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(setup);

      return MachineSetupsRepository.of({
        findOne: Ref.get(store),
        save: (saved: MachineSetupRoot) => Ref.set(store, saved),
      });
    }),
  );
