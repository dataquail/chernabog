import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { AppRole } from "../domain/machine-setup/app-role.value-object.ts";
import {
  AppKeyNotReady,
  AppPersonaUnknown,
  GitHubAppsFailed,
  InstallationNotOnRepo,
} from "../domain/machine-setup/machine-setup.errors.ts";

// An App now installed on the repo: the persona machine config acts as it
// by, its id on GitHub, whether it's one this machine acted as already, its
// installation, the other repos that installation covers, whose tokens it
// can write to as well, and the Environment set up for it, if one was.
export class InstalledApp extends Schema.Class<InstalledApp, { readonly brand: "InstalledApp" }>(
  "InstalledApp",
)({
  login: Schema.String,
  id: Schema.String,
  reused: Schema.Boolean,
  installation: Schema.String,
  alsoOn: Schema.Array(Schema.String),
  environment: Schema.Option(Schema.String),
}) {}

// Takes an App a person installed on the repo (#481): finds its
// installation there as the App, so a forged redirect can't name another,
// and adds it to machine config as a persona whose tokens it makes. The App
// is one just created, or, without one, the App this machine already acts as
// for the role on the repo's owner, installed on another repo too: an
// installation is the owner's, so one persona acts on every repo it covers.
// That App is found by asking GitHub, as each App this machine acts as,
// whose it is and what it may do, not by its name: the person may have
// renamed it, and GitHub lowercases the name it makes the login from. None
// is AppPersonaUnknown. With environments,
// also sets up the repo's Environment for the App's role, holding its id and
// key for CI. Not installed on the repo yet is InstallationNotOnRepo, which
// the person can put right and ask again; AppKeyNotReady, for an App only
// just made, passes by itself.
export const InstallAppCommand = Command.make("InstallAppCommand", {
  payload: {
    role: AppRole,
    repo: Schema.String,
    // The App just created: its bot's login, its id, and where its key is kept.
    created: Schema.Option(
      Schema.Struct({ login: Schema.String, id: Schema.String, key: Schema.String }),
    ),
    environments: Schema.Boolean,
  },
  success: InstalledApp,
  failure: Schema.Union([
    InstallationNotOnRepo,
    AppKeyNotReady,
    AppPersonaUnknown,
    GitHubAppsFailed,
    PersistenceFailed,
  ]),
});

export type InstallAppPayload = Command.Payload<typeof InstallAppCommand>;
