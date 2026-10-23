import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type Checkout } from "../../enrolled-repo/checkout.value-object.ts";
import { type CheckoutUnreadable } from "../../enrolled-repo/enrolled-repo.errors.ts";

// Checkouts on this machine, through git and their working copies.
export type CheckoutsClientService = {
  // The root of the checkout a path is in.
  readonly rootOf: (path: string) => Effect.Effect<string, CheckoutUnreadable>;
  // What enrolling the checkout at `root` reads of it.
  readonly inspect: (root: string) => Effect.Effect<Checkout, CheckoutUnreadable>;
  // Whether a checkout is still where an entry says; one that can't be told is.
  readonly exists: (path: string) => Effect.Effect<boolean>;
};

export class CheckoutsClient extends Context.Service<CheckoutsClient, CheckoutsClientService>()(
  "CheckoutsClient",
) {}
