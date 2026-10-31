import * as Effect from "effect/Effect";

import { CheckoutsClient } from "../domain/ports/clients/checkouts.client.ts";
import { CheckoutRoot, type FindCheckoutRootPayload } from "./find-checkout-root.query.ts";

export const findCheckoutRootHandler = Effect.fn("findCheckoutRootHandler")(function* (
  query: FindCheckoutRootPayload,
) {
  return CheckoutRoot.make({ root: yield* (yield* CheckoutsClient).rootOf(query.path) });
});
