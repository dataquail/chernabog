import * as Effect from "effect/Effect";

import { MachineSetupRootOps } from "../domain/machine-setup/machine-setup.root-ops.ts";
import { AccountDirsClient } from "../domain/ports/clients/account-dirs.client.ts";
import { GitHubLoginsClient } from "../domain/ports/clients/github-logins.client.ts";
import { MachineSetupsRepository } from "../domain/ports/repositories/machine-setups.repository.ts";
import { AccountDir } from "./inspect-account-dir.query.ts";
import { SetupPlan } from "./plan-setup.query.ts";

export const planSetupHandler = Effect.fn("planSetupHandler")(function* () {
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
