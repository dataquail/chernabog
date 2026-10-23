import * as Effect from "effect/Effect";

import { MachineSetupRootOps } from "../domain/machine-setup/machine-setup.root-ops.ts";
import { AccountDirsClient } from "../domain/ports/clients/account-dirs.client.ts";
import { AccountDir } from "./setup.result.ts";

// An account directory a person typed, ~ and all: where it is, and the agent
// its name says it's for, if it says.
export const inspectAccountDirUseCase = Effect.fn("inspectAccountDirUseCase")(function* (
  typed: string,
) {
  const home = yield* (yield* AccountDirsClient).home;
  const dir = MachineSetupRootOps.expandHome(typed.trim(), home);

  return AccountDir.make({
    dir,
    display: MachineSetupRootOps.homeRelative(dir, home),
    agent: MachineSetupRootOps.agentOfDir(dir),
  });
});
