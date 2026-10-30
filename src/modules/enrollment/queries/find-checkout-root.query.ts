import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { CheckoutUnreadable } from "../domain/enrolled-repo/enrolled-repo.errors.ts";

// The root of the checkout a path is in.
export class CheckoutRoot extends Schema.Class<CheckoutRoot, { readonly brand: "CheckoutRoot" }>(
  "CheckoutRoot",
)({
  root: Schema.String,
}) {}

// The root of the checkout a path is in, which init, enroll and recipes act on.
export const FindCheckoutRootQuery = Query.make("FindCheckoutRootQuery", {
  payload: { path: Schema.String },
  success: CheckoutRoot,
  failure: CheckoutUnreadable,
});

export type FindCheckoutRootPayload = Query.Payload<typeof FindCheckoutRootQuery>;
