import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { MachineSetupsRepository } from "../domain/ports/repositories/machine-setups.repository.ts";
import { MachineSetupView } from "./read-machine-setup.query.ts";

export const readMachineSetupHandler = Effect.fn("readMachineSetupHandler")(function* () {
  const setup = yield* (yield* MachineSetupsRepository).findOne;

  const accounts = Option.getOrElse(
    Option.liftPredicate(setup.accounts, () => setup.accountsWritten),
    () => [{ name: "work", agent: "claude" }],
  );

  return MachineSetupView.make({
    personas: setup.personas,
    accounts: accounts.map((account) => ({ name: account.name, agent: account.agent })),
  });
});
