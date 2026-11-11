// The GitHub Apps' private keys, under the home's keys/: written atomically,
// readable only by the person from the moment they exist (mode 0600), in a
// directory only the person may list (0700).

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { PersistenceFailed } from "../../../../kernel/persistence.errors.ts";
import { writeFileAtomic } from "../../../../platform/atomic-write.ts";
import { expandHome, Home, homePaths } from "../../../../platform/home.ts";
import { AppKeysClient } from "../../domain/ports/clients/app-keys.client.ts";

// A path as machine config writes it: ~ for the person's home.
const homeRelative = (path: string, home: string) => {
  if (path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }

  return path;
};

export const AppKeysClientLive = Layer.effect(
  AppKeysClient,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Home;

    const write = (slug: string, privateKey: string) =>
      Effect.gen(function* () {
        const path = homePaths(home.root).appKey(slug);
        const dir = path.slice(0, path.lastIndexOf("/"));

        yield* fs.makeDirectory(dir, { recursive: true });
        yield* fs.chmod(dir, 0o700);
        yield* writeFileAtomic(fs, path, privateKey, 0o600);

        return homeRelative(path, home.user);
      }).pipe(
        Effect.mapError(
          (error) =>
            new PersistenceFailed({ message: `writing ${slug}'s private key: ${error.message}` }),
        ),
      );

    const read = (path: string) =>
      fs
        .readFileString(expandHome(path, home.user))
        .pipe(
          Effect.mapError(
            (error) => new PersistenceFailed({ message: `reading ${path}: ${error.message}` }),
          ),
        );

    return AppKeysClient.of({ write, read });
  }),
);
