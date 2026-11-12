import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { GitHubAppsFailed } from "../domain/machine-setup/machine-setup.errors.ts";

// An App GitHub made from a manifest: its id and slug, the bot it acts as,
// where its private key is now kept, and where a person installs it.
export class CreatedApp extends Schema.Class<CreatedApp, { readonly brand: "CreatedApp" }>(
  "CreatedApp",
)({
  id: Schema.String,
  slug: Schema.String,
  login: Schema.String,
  key: Schema.String,
  installUrl: Schema.String,
}) {}

// Takes the App a person just created from a manifest (#481): trades the
// code GitHub sent back for it, within the hour, and keeps its private key
// on this machine, readable only by the person.
export const CreateAppCommand = Command.make("CreateAppCommand", {
  payload: { code: Schema.String },
  success: CreatedApp,
  failure: Schema.Union([GitHubAppsFailed, PersistenceFailed]),
});

export type CreateAppPayload = Command.Payload<typeof CreateAppCommand>;
