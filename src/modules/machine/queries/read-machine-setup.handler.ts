import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { MachineSetupRootOps } from "../domain/machine-setup/machine-setup.root-ops.ts";
import { MachineSetupSpecifications } from "../domain/machine-setup/machine-setup.specification.ts";
import { MachineSetupsRepository } from "../domain/machine-setup/machine-setups.repository.ts";
import { MachineSetupView } from "./read-machine-setup.query.ts";

export const readMachineSetupHandler = Effect.fn("readMachineSetupHandler")(function* () {
  const setup = Option.getOrElse(
    yield* (yield* MachineSetupsRepository).findOne(MachineSetupSpecifications.thisMachine),
    () => MachineSetupRootOps.unset,
  );

  const accounts = Option.getOrElse(
    Option.liftPredicate(setup.accounts, () => setup.accountsWritten),
    () => [{ name: "work", agent: "claude" }],
  );

  return MachineSetupView.make({
    personas: setup.personas,
    accounts: accounts.map((account) => ({ name: account.name, agent: account.agent })),
  });
});
