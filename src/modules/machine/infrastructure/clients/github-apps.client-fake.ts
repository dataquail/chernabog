import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { GitHubAppsFailed } from "../../domain/machine-setup/machine-setup.errors.ts";
import {
  type AppEnvironment,
  type ConvertedApp,
  GitHubAppsClient,
} from "../../domain/ports/clients/github-apps.client.ts";

// GitHub as a test sets it up: the organizations, the App each manifest code
// makes, each App's installation by repo (`<app id> <repo>`) and the repos
// each installation covers (by installation, every repo it's on unless
// given). The
// Environments it was asked to set up are pushed onto `provisioned`.
export type GitHubAppsWorld = {
  readonly organizations?: ReadonlyArray<string>;
  readonly codes?: Readonly<Record<string, ConvertedApp>>;
  readonly installations?: Readonly<Record<string, string>>;
  readonly repositories?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly provisioned?: Array<AppEnvironment>;
};

export const GitHubAppsClientFake = (world: GitHubAppsWorld = {}) =>
  Layer.succeed(
    GitHubAppsClient,
    GitHubAppsClient.of({
      ownerIsOrganization: (owner) => Effect.succeed((world.organizations ?? []).includes(owner)),
      convertManifest: (code) =>
        Effect.fromOption(Option.fromUndefinedOr(world.codes?.[code])).pipe(
          Effect.mapError(
            () => new GitHubAppsFailed({ message: `GitHub made no App from code ${code}` }),
          ),
        ),
      installationOn: (app, repo) =>
        Effect.succeed(Option.fromUndefinedOr(world.installations?.[`${app.id} ${repo}`])),
      repositoriesOf: (app, installation) =>
        Effect.succeed(
          world.repositories?.[installation] ??
            Object.entries(world.installations ?? {})
              .filter(([key, found]) => found === installation && key.startsWith(`${app.id} `))
              .map(([key]) => key.slice(app.id.length + 1)),
        ),
      provisionEnvironment: (environment) =>
        Effect.sync(() => {
          world.provisioned?.push(environment);
        }),
    }),
  );
