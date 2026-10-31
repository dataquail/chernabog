import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type CheckoutTree } from "../../enrolled-repo/checkout.value-object.ts";
import { type CheckoutUnreadable } from "../../enrolled-repo/enrolled-repo.errors.ts";

// Checkouts on this machine, through git and their working copies.
export type CheckoutsClientService = {
  // The root of the checkout a path is in.
  readonly rootOf: (path: string) => Effect.Effect<string, CheckoutUnreadable>;
  // The checkout at `root`: its repo and the flows it has. What its team says
  // of them is the team's config, which TeamFlowsAcl asks.
  readonly inspect: (root: string) => Effect.Effect<CheckoutTree, CheckoutUnreadable>;
  // Whether a checkout is still where an entry says; one that can't be told is.
  readonly exists: (path: string) => Effect.Effect<boolean>;
};

export class CheckoutsClient extends Context.Service<CheckoutsClient, CheckoutsClientService>()(
  "CheckoutsClient",
) {}
