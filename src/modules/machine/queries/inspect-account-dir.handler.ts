import * as Effect from "effect/Effect";

import { MachineSetupRootOps } from "../domain/machine-setup/machine-setup.root-ops.ts";
import { AccountDirsClient } from "../domain/ports/clients/account-dirs.client.ts";
import { AccountDir, type InspectAccountDirPayload } from "./inspect-account-dir.query.ts";

export const inspectAccountDirHandler = Effect.fn("inspectAccountDirHandler")(function* (
  query: InspectAccountDirPayload,
) {
  const home = yield* (yield* AccountDirsClient).home;
  const dir = MachineSetupRootOps.expandHome(query.typed.trim(), home);

  return AccountDir.make({
    dir,
    display: MachineSetupRootOps.homeRelative(dir, home),
    agent: MachineSetupRootOps.agentOfDir(dir),
  });
});
