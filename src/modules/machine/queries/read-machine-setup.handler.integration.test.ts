import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effectAtHome } from "../../../../test/effect-test.ts";
import { MachineSetupRoot } from "../domain/machine-setup/machine-setup.root.ts";
import { MachineSetupsRepository } from "../domain/machine-setup/machine-setups.repository.ts";
import { MachineSetupsRepositoryLive } from "../infrastructure/repositories/machine-setups.repository-live.ts";
import { readMachineSetupHandler } from "./read-machine-setup.handler.ts";

describe("readMachineSetupHandler", () => {
  effectAtHome(
    "lists the personas and accounts, and the default work account when none are written",
    () =>
      Effect.gen(function* () {
        yield* (yield* MachineSetupsRepository).upsertOne(
          MachineSetupRoot.make({ personas: ["alice"], accounts: [], accountsWritten: false }),
        );

        const view = yield* readMachineSetupHandler();

        expect(view.personas).toEqual(["alice"]);
        expect(view.accounts).toEqual([{ name: "work", agent: "claude" }]);
      }).pipe(Effect.provide(MachineSetupsRepositoryLive)),
  );
});
