import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";

import { AppRoles } from "../domain/domain-services/app-roles.domain-service.ts";
import { AppKeysClient } from "../domain/ports/clients/app-keys.client.ts";
import { GitHubAppsClient } from "../domain/ports/clients/github-apps.client.ts";
import { type CreateAppPayload, CreatedApp } from "./create-app.command.ts";

export const createAppHandler = Effect.fn("createAppHandler")(
  function* (command: CreateAppPayload) {
    const app = yield* (yield* GitHubAppsClient).convertManifest(command.code);
    const key = yield* (yield* AppKeysClient).write(app.slug, app.privateKey);

    return CreatedApp.make({
      id: app.id,
      slug: app.slug,
      login: AppRoles.loginOf(app.slug),
      key,
      installUrl: AppRoles.installUrl(app.slug),
    });
  },
  withUnitOfWork,
  // Its store is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
