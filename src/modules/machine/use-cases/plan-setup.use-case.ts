import * as Effect from "effect/Effect";

import { MachineSetupRootOps } from "../domain/machine-setup/machine-setup.root-ops.ts";
import { AccountDirsClient } from "../domain/ports/clients/account-dirs.client.ts";
import { GitHubLoginsClient } from "../domain/ports/clients/github-logins.client.ts";
import { MachineSetupsRepository } from "../domain/ports/repositories/machine-setups.repository.ts";
import { AccountDir, SetupPlan } from "./setup.result.ts";

// What setting up the machine can choose from: gh's logins, and the agents'
// account directories in the home that no account names yet.
export const planSetupUseCase = Effect.fn("planSetupUseCase")(function* () {
  const setup = yield* (yield* MachineSetupsRepository).findOne;
  const dirs = yield* AccountDirsClient;
  const home = yield* dirs.home;
  const known = MachineSetupRootOps.knownDirs(setup, home);

  return SetupPlan.make({
    loggedIn: yield* (yield* GitHubLoginsClient).logins,
    personas: setup.personas,
    accountsWritten: setup.accountsWritten,
    candidates: (yield* dirs.found)
      .filter((dir) => !known.includes(dir))
      .map((dir) =>
        AccountDir.make({
          dir,
          display: MachineSetupRootOps.homeRelative(dir, home),
          agent: MachineSetupRootOps.agentOfDir(dir),
        }),
      ),
  });
});
