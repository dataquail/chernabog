import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { type MachineSetupRoot } from "../../domain/machine-setup/machine-setup.root.ts";
import { MachineSetupsRepository } from "../../domain/machine-setup/machine-setups.repository.ts";

// A machine's setup in memory, starting from `setup`.
export const MachineSetupsRepositoryFake = (setup: MachineSetupRoot) =>
  Layer.effect(
    MachineSetupsRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make(setup);

      return MachineSetupsRepository.of({
        findOne: (spec) =>
          Ref.get(store).pipe(Effect.map((stored) => Option.filter(Option.some(stored), spec))),
        upsertOne: (saved: MachineSetupRoot) => Ref.set(store, saved),
      });
    }),
  );
