import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Record from "effect/Record";

import { CheckoutTree } from "../../domain/enrolled-repo/checkout.value-object.ts";
import { CheckoutUnreadable } from "../../domain/enrolled-repo/enrolled-repo.errors.ts";
import { CheckoutsClient } from "../../domain/ports/clients/checkouts.client.ts";

// The checkouts on a machine, by root; a path inside one is in it. A path
// that's neither a checkout's nor `present` isn't there.
export const CheckoutsClientFake = (
  checkouts: ReadonlyArray<Pick<CheckoutTree, "root" | "repo" | "flows">>,
  present: ReadonlyArray<string> = [],
) => {
  const byRoot = Object.fromEntries(checkouts.map((checkout) => [checkout.root, checkout]));

  const rootOf = (path: string) =>
    Effect.fromOption(
      Arr.findFirst(
        checkouts,
        (checkout) => path === checkout.root || path.startsWith(`${checkout.root}/`),
      ),
    ).pipe(
      Effect.map((checkout) => checkout.root),
      Effect.mapError(() => new CheckoutUnreadable({ message: `${path}: not a git repository` })),
    );

  return Layer.succeed(
    CheckoutsClient,
    CheckoutsClient.of({
      rootOf,
      inspect: (root) =>
        Effect.fromOption(Record.get(byRoot, root)).pipe(
          Effect.map(({ flows, repo }) => CheckoutTree.make({ root, repo, flows })),
          Effect.mapError(
            () => new CheckoutUnreadable({ message: `${root}: not a git repository` }),
          ),
        ),
      exists: (path) => Effect.succeed(path in byRoot || present.includes(path)),
    }),
  );
};
