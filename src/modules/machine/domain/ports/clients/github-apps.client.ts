import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import {
  type AppKeyNotReady,
  type GitHubAppsFailed,
} from "../../machine-setup/machine-setup.errors.ts";

// An App GitHub made from a manifest: its id, its slug and its private key.
export type ConvertedApp = {
  readonly id: string;
  readonly slug: string;
  readonly privateKey: string;
};

// An App to act as: its id and its private key.
export type AppCredentials = { readonly id: string; readonly privateKey: string };

// An App as GitHub has it now, asked as the App: its slug, the account that
// owns it, and what it may do on the repos it's installed on.
export type DescribedApp = {
  readonly slug: string;
  readonly owner: string;
  readonly permissions: Readonly<Record<string, string>>;
};

// A repo's GitHub Environment for one App: which branches may use it, its
// variables and its secrets, each set to the value given.
export type AppEnvironment = {
  readonly repo: string;
  readonly name: string;
  readonly defaultBranchOnly: boolean;
  readonly variables: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
};

// GitHub's side of making a repo's Apps (#481): whether an owner is an
// organization, the App a manifest's code made, an App as it is now and its
// installation on a repo, as the App sees them, and a repo's Environments,
// as the person running the command.
export type GitHubAppsClientService = {
  readonly ownerIsOrganization: (owner: string) => Effect.Effect<boolean, GitHubAppsFailed>;
  readonly convertManifest: (code: string) => Effect.Effect<ConvertedApp, GitHubAppsFailed>;
  // The App as GitHub has it now, which a rename on GitHub changes the name
  // of but not the owner or permissions. AppKeyNotReady as installationOn.
  readonly describeApp: (
    app: AppCredentials,
  ) => Effect.Effect<DescribedApp, GitHubAppsFailed | AppKeyNotReady>;
  // The App's installation id on the repo; none when it isn't installed
  // there. AppKeyNotReady for an App so new GitHub doesn't take its key yet.
  readonly installationOn: (
    app: AppCredentials,
    repo: string,
  ) => Effect.Effect<Option.Option<string>, GitHubAppsFailed | AppKeyNotReady>;
  // The repos an installation of the App covers, as owner/name, as the
  // installation's own token sees them.
  readonly repositoriesOf: (
    app: AppCredentials,
    installation: string,
  ) => Effect.Effect<ReadonlyArray<string>, GitHubAppsFailed | AppKeyNotReady>;
  readonly provisionEnvironment: (
    environment: AppEnvironment,
  ) => Effect.Effect<void, GitHubAppsFailed>;
};

export class GitHubAppsClient extends Context.Service<GitHubAppsClient, GitHubAppsClientService>()(
  "GitHubAppsClient",
) {}
