// GitHub's side of making a repo's Apps (#481). An App's own calls go
// straight to the API: trading a manifest's code needs no token, and finding
// an App's installation is signed with the App's JWT. Telling an owner's kind
// and setting up a repo's Environments act as the person running the command
// (GitHubApi's implicit persona), and an Environment's secrets go through
// `gh secret set`, which encrypts them for the repo.

import { type Json, printJson } from "@chernabog/core";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpMethod from "effect/http/HttpMethod";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { Exec } from "../../../../platform/exec.ts";
import { decodeBody, GitHubApi } from "../../../../platform/github-api.ts";
import { appJwt, installationToken } from "../../../../platform/github-token-source.ts";
import {
  AppKeyNotReady,
  GitHubAppsFailed,
} from "../../domain/machine-setup/machine-setup.errors.ts";
import {
  type AppCredentials,
  type AppEnvironment,
  GitHubAppsClient,
} from "../../domain/ports/clients/github-apps.client.ts";

const Conversion = Schema.Struct({ id: Schema.Int, slug: Schema.String, pem: Schema.String });
const Installation = Schema.Struct({ id: Schema.Int });

const App = Schema.Struct({
  slug: Schema.String,
  owner: Schema.Struct({ login: Schema.String }),
  permissions: Schema.Record(Schema.String, Schema.String),
});

const InstallationRepositories = Schema.Struct({
  total_count: Schema.Int,
  repositories: Schema.Array(Schema.Struct({ full_name: Schema.String })),
});

// An installation's repos come a page at a time; a hundred is GitHub's most.
const PER_PAGE = 100;
const Owner = Schema.Struct({ type: Schema.String });
const Repository = Schema.Struct({ default_branch: Schema.String });

const BranchPolicies = Schema.Struct({
  branch_policies: Schema.Array(Schema.Struct({ name: Schema.String })),
});

const failed = (error: { readonly message: string }) =>
  new GitHubAppsFailed({ message: error.message });

// An App call's answer, which is text, read into a schema's type.
const decoded = <A>(schema: Schema.Codec<A, unknown>, what: string, text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(
      (issue) =>
        new GitHubAppsFailed({ message: `${what}: unexpected response: ${issue.message}` }),
    ),
  );

// A person's call's answer, read into a schema's type.
const read =
  <A>(schema: Schema.Codec<A, Json>, what: string) =>
  (body: Option.Option<Json>) =>
    decodeBody(schema, what)(body).pipe(Effect.mapError(failed));

const said = (body: Option.Option<Json>) =>
  Option.match(body, { onNone: () => "no body", onSome: printJson });

export const GitHubAppsClientLive = Layer.effect(
  GitHubAppsClient,
  Effect.gen(function* () {
    const services = yield* Effect.context<HttpClient.HttpClient | GitHubApi | Exec>();
    const client = yield* HttpClient.HttpClient;

    // CHERNABOG_GITHUB_API points at another API, such as a test server.
    const root = yield* Config.String("CHERNABOG_GITHUB_API").pipe(
      Config.withDefault("https://api.github.com"),
      Effect.orDie,
    );

    // A call of the App's own, signed by `bearer` when it has one.
    const own = (method: HttpMethod.HttpMethod, path: string, bearer: Option.Option<string>) =>
      Effect.gen(function* () {
        const base = HttpClientRequest.make(method)(`${root}${path}`).pipe(
          HttpClientRequest.setHeaders({
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          }),
        );

        const request = Option.match(bearer, {
          onNone: () => base,
          onSome: (token) => HttpClientRequest.bearerToken(base, token),
        });

        const response = yield* client.execute(request);

        return { status: response.status, text: yield* response.text };
      }).pipe(
        Effect.mapError(
          (error) => new GitHubAppsFailed({ message: `${method} ${path}: ${error.message}` }),
        ),
      );

    // A call as the person, which must succeed.
    const asPerson = (method: HttpMethod.HttpMethod, path: string, body?: Json) =>
      Effect.gen(function* () {
        const response = yield* (yield* GitHubApi).request(
          method,
          path,
          Option.fromUndefinedOr(body),
        );

        if (response.status >= 300) {
          return yield* new GitHubAppsFailed({
            message: `${method} ${path} returned HTTP ${response.status}: ${said(response.body)}`,
          });
        }

        return response.body;
      }).pipe(Effect.mapError(failed), Effect.provideContext(services));

    const ownerIsOrganization = (owner: string) =>
      asPerson("GET", `/users/${owner}`).pipe(
        Effect.flatMap(read(Owner, `GET /users/${owner}`)),
        Effect.map((found) => found.type === "Organization"),
      );

    const convertManifest = (code: string) =>
      Effect.gen(function* () {
        const path = `/app-manifests/${code}/conversions`;
        const response = yield* own("POST", path, Option.none());

        if (response.status !== 201) {
          return yield* new GitHubAppsFailed({
            message: `GitHub made no App from the manifest (POST ${path}: HTTP ${response.status} ${response.text}); a code lasts an hour, so run chernabog ci apps again`,
          });
        }

        const app = yield* decoded(Conversion, `POST ${path}`, response.text);

        return { id: String(app.id), slug: app.slug, privateKey: app.pem };
      });

    // A call signed with the App's JWT. What GitHub says for a moment after
    // it made the App, before it takes its key, is AppKeyNotReady.
    const asApp = (app: AppCredentials, path: string) =>
      Effect.gen(function* () {
        const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);

        const jwt = yield* Effect.try({
          try: () => appJwt(app.id, app.privateKey, now),
          catch: (error) =>
            new GitHubAppsFailed({ message: `signing as App ${app.id}: ${String(error)}` }),
        });

        const response = yield* own("GET", path, Option.some(jwt));

        if (response.status === 401 && response.text.includes("must generate a public key")) {
          return yield* new AppKeyNotReady({ id: app.id });
        }

        return response;
      });

    const describeApp = (app: AppCredentials) =>
      Effect.gen(function* () {
        const response = yield* asApp(app, "/app");

        if (response.status !== 200) {
          return yield* new GitHubAppsFailed({
            message: `GET /app as App ${app.id}: HTTP ${response.status} ${response.text}`,
          });
        }

        const found = yield* decoded(App, "GET /app", response.text);

        return { slug: found.slug, owner: found.owner.login, permissions: found.permissions };
      });

    const installationOn = (app: AppCredentials, repo: string) =>
      Effect.gen(function* () {
        const path = `/repos/${repo}/installation`;
        const response = yield* asApp(app, path);

        if (response.status === 404) {
          return Option.none<string>();
        }

        if (response.status !== 200) {
          return yield* new GitHubAppsFailed({
            message: `GET ${path} as App ${app.id}: HTTP ${response.status} ${response.text}`,
          });
        }

        return Option.some(String((yield* decoded(Installation, `GET ${path}`, response.text)).id));
      });

    const repositoriesOf = (app: AppCredentials, installation: string) =>
      Effect.gen(function* () {
        const { token } = yield* installationToken({
          kind: "app",
          id: app.id,
          installation,
          privateKey: app.privateKey,
        }).pipe(Effect.mapError(failed), Effect.provideContext(services));

        const names: Array<string> = [];

        for (let pageNumber = 1; ; pageNumber++) {
          const path = `/installation/repositories?per_page=${PER_PAGE}&page=${pageNumber}`;
          const response = yield* own("GET", path, Option.some(token));

          if (response.status !== 200) {
            return yield* new GitHubAppsFailed({
              message: `GET ${path} as installation ${installation}: HTTP ${response.status} ${response.text}`,
            });
          }

          const found = yield* decoded(InstallationRepositories, `GET ${path}`, response.text);

          for (const repository of found.repositories) {
            names.push(repository.full_name);
          }

          if (found.repositories.length < PER_PAGE || names.length >= found.total_count) {
            return names;
          }
        }
      });

    // Keeps the Environment to the repo's default branch, adding that branch's policy once.
    const defaultBranchOnly = (repo: string, name: string) =>
      Effect.gen(function* () {
        const environment = `/repos/${repo}/environments/${name}`;

        yield* asPerson("PUT", environment, {
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        });

        const branch = (yield* asPerson("GET", `/repos/${repo}`).pipe(
          Effect.flatMap(read(Repository, `GET /repos/${repo}`)),
        )).default_branch;

        const policies = `${environment}/deployment-branch-policies`;

        const known = yield* asPerson("GET", policies).pipe(
          Effect.flatMap(read(BranchPolicies, `GET ${policies}`)),
        );

        if (!known.branch_policies.some((policy) => policy.name === branch)) {
          yield* asPerson("POST", policies, { name: branch, type: "branch" });
        }
      });

    // Sets a variable, creating it the first time and updating it after.
    const setVariable = (repo: string, environment: string, name: string, value: string) =>
      Effect.gen(function* () {
        const variables = `/repos/${repo}/environments/${environment}/variables`;
        const api = yield* GitHubApi;

        const created = yield* api
          .request("POST", variables, Option.some({ name, value }))
          .pipe(Effect.mapError(failed));

        if (created.status === 409) {
          yield* asPerson("PATCH", `${variables}/${name}`, { name, value });

          return;
        }

        if (created.status >= 300) {
          return yield* new GitHubAppsFailed({
            message: `POST ${variables} returned HTTP ${created.status}: ${said(created.body)}`,
          });
        }
      }).pipe(Effect.provideContext(services));

    // The secret goes to gh on stdin, so it's never in a process's arguments.
    const setSecret = (repo: string, environment: string, name: string, value: string) =>
      Effect.gen(function* () {
        const result = yield* (yield* Exec)
          .run("gh", ["secret", "set", name, "--env", environment, "--repo", repo], {
            stdin: value,
          })
          .pipe(Effect.mapError(failed));

        if (result.exitCode !== 0) {
          return yield* new GitHubAppsFailed({
            message: `gh secret set ${name} --env ${environment} --repo ${repo}: ${result.stderr.trim()}`,
          });
        }
      }).pipe(Effect.provideContext(services));

    const provisionEnvironment = (environment: AppEnvironment) =>
      Effect.gen(function* () {
        const { name, repo } = environment;

        if (environment.defaultBranchOnly) {
          yield* defaultBranchOnly(repo, name);
        } else {
          // Any branch may use it, as a new Environment lets.
          yield* asPerson("PUT", `/repos/${repo}/environments/${name}`, {});
        }

        for (const [variable, value] of Object.entries(environment.variables)) {
          yield* setVariable(repo, name, variable, value);
        }

        for (const [secret, value] of Object.entries(environment.secrets)) {
          yield* setSecret(repo, name, secret, value);
        }
      });

    return GitHubAppsClient.of({
      ownerIsOrganization,
      convertManifest,
      describeApp,
      installationOn,
      repositoriesOf,
      provisionEnvironment,
    });
  }),
);
