import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { MachineSetupsRepository } from "../domain/ports/repositories/machine-setups.repository.ts";
import { MachineSetupView } from "./setup.result.ts";

// The personas this machine acts as and the accounts it spends. Without
// accounts: it has the one default, work, for claude.
export const readMachineSetupUseCase = Effect.fn("readMachineSetupUseCase")(function* () {
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
