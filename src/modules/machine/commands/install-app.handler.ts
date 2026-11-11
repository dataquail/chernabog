import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { AppRoles } from "../domain/domain-services/app-roles.domain-service.ts";
import { AppPersona } from "../domain/machine-setup/app-persona.value-object.ts";
import {
  AppPersonaUnknown,
  InstallationNotOnRepo,
} from "../domain/machine-setup/machine-setup.errors.ts";
import { MachineSetupRootOps } from "../domain/machine-setup/machine-setup.root-ops.ts";
import { MachineSetupSpecifications } from "../domain/machine-setup/machine-setup.specification.ts";
import { MachineSetupsRepository } from "../domain/machine-setup/machine-setups.repository.ts";
import { AppKeysClient } from "../domain/ports/clients/app-keys.client.ts";
import { GitHubAppsClient } from "../domain/ports/clients/github-apps.client.ts";
import { type InstallAppPayload, InstalledApp } from "./install-app.command.ts";

export const installAppHandler = Effect.fn("installAppHandler")(
  function* (command: InstallAppPayload) {
    const apps = yield* GitHubAppsClient;
    const repository = yield* MachineSetupsRepository;

    const before = Option.getOrElse(
      yield* repository.findOne(MachineSetupSpecifications.thisMachine),
      () => MachineSetupRootOps.unset,
    );

    const app = yield* Option.match(command.created, {
      onSome: Effect.succeed,
      onNone: () =>
        Effect.fromOption(MachineSetupRootOps.appOf(before, command.login)).pipe(
          Effect.mapError(() => new AppPersonaUnknown({ login: command.login })),
        ),
    });

    const privateKey = yield* (yield* AppKeysClient).read(app.key);
    const installation = yield* apps.installationOn({ id: app.id, privateKey }, command.repo);

    if (Option.isNone(installation)) {
      return yield* new InstallationNotOnRepo({
        slug: AppRoles.slugOf(command.login),
        repo: command.repo,
      });
    }

    const covered = yield* apps.repositoriesOf({ id: app.id, privateKey }, installation.value);

    const persona = AppPersona.make({
      login: command.login,
      id: app.id,
      installation: installation.value,
      key: app.key,
    });

    yield* repository.upsertOne(MachineSetupRootOps.addApp(before, persona));

    const environment = Option.liftPredicate(
      AppRoles.environmentOf(command.role),
      () => command.environments,
    );

    for (const name of Option.toArray(environment)) {
      yield* apps.provisionEnvironment({
        repo: command.repo,
        name,
        defaultBranchOnly: AppRoles.defaultBranchOnly(command.role),
        variables: { [AppRoles.APP_ID_VARIABLE]: app.id },
        secrets: { [AppRoles.APP_KEY_SECRET]: privateKey },
      });
    }

    return InstalledApp.make({
      login: persona.login,
      installation: installation.value,
      alsoOn: covered.filter((other) => other !== command.repo),
      environment,
    });
  },
  withUnitOfWork,
  // Its stores are files on this machine: they have no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
