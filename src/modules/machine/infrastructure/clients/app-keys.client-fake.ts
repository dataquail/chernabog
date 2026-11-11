import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { PersistenceFailed } from "../../../../kernel/persistence.errors.ts";
import { AppKeysClient } from "../../domain/ports/clients/app-keys.client.ts";

// Keys kept in `keys`, by path, each written as ~/keys/<slug>.pem.
export const AppKeysClientFake = (keys = new Map<string, string>()) =>
  Layer.succeed(
    AppKeysClient,
    AppKeysClient.of({
      write: (slug, privateKey) =>
        Effect.sync(() => {
          const path = `~/keys/${slug}.pem`;
          keys.set(path, privateKey);

          return path;
        }),
      read: (path) =>
        Effect.fromOption(Option.fromUndefinedOr(keys.get(path))).pipe(
          Effect.mapError(() => new PersistenceFailed({ message: `no key at ${path}` })),
        ),
    }),
  );
