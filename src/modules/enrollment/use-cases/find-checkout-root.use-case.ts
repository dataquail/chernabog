import * as Effect from "effect/Effect";

import { CheckoutsClient } from "../domain/ports/clients/checkouts.client.ts";
import { CheckoutRoot } from "./enrollment.result.ts";

// The root of the checkout a path is in, which init, enroll and recipes act on.
export const findCheckoutRootUseCase = Effect.fn("findCheckoutRootUseCase")(function* (
  path: string,
) {
  return CheckoutRoot.make({ root: yield* (yield* CheckoutsClient).rootOf(path) });
});
