import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { ServiceFailed } from "../domain/machine-setup/machine-setup.errors.ts";

// The unit an upgrade rewrote, if it rewrote one.
export class RefreshedService extends Schema.Class<
  RefreshedService,
  { readonly brand: "RefreshedService" }
>("RefreshedService")({
  rewrote: Schema.Option(Schema.String),
}) {}

// Rolls a change to the service unit out to an install from before it: the
// daemon dispatches it as it starts on a new chernabog.
export const RefreshServiceCommand = Command.make("RefreshServiceCommand", {
  success: RefreshedService,
  failure: ServiceFailed,
});
