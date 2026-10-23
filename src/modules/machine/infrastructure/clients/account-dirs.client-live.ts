// The agents' account directories in the person's home: a dot directory per
// claude or codex login, such as ~/.claude and ~/.claude-personal. opencode
// keeps its login elsewhere, so it isn't looked for.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Order from "effect/Order";

import { Home } from "../../../../config.ts";
import { AccountDirsClient } from "../../domain/ports/clients/account-dirs.client.ts";

const FOUND_DIR = /^\.(claude|codex)(?:-[\w.-]+)?$/;

export const AccountDirsClientLive = Layer.effect(
  AccountDirsClient,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = (yield* Home).user;

    const found = Effect.gen(function* () {
      const dirs: Array<string> = [];

      for (const entry of Arr.sort(yield* fs.readDirectory(home), Order.String)) {
        const path = `${home}/${entry}`;

        if (FOUND_DIR.test(entry) && (yield* fs.stat(path)).type === "Directory") {
          dirs.push(path);
        }
      }

      return dirs;
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    return AccountDirsClient.of({
      home: Effect.succeed(home),
      found,
      exists: (dir) => fs.exists(dir).pipe(Effect.orElseSucceed(() => false)),
    });
  }),
);
