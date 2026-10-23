import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AccountDirsClient } from "../../domain/ports/clients/account-dirs.client.ts";

// A home at `home` holding `dirs`, in full; of them, the agents' own are found.
export const AccountDirsClientFake = (home: string, dirs: ReadonlyArray<string>) =>
  Layer.succeed(
    AccountDirsClient,
    AccountDirsClient.of({
      home: Effect.succeed(home),
      found: Effect.succeed(
        dirs.filter((dir) => /^\.(claude|codex)(-[\w.-]+)?$/.test(dir.split("/").at(-1) ?? "")),
      ),
      exists: (dir) => Effect.succeed(dirs.includes(dir)),
    }),
  );
