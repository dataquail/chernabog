import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { effectAtHomeWith } from "../../../../../test/effect-test.ts";
import { type Exec, type ExecOptions, execTestLayer } from "../../../../platform/exec.ts";
import { GitHubApi } from "../../../../platform/github-api.ts";
import { GitHubAppsClient } from "../../domain/ports/clients/github-apps.client.ts";
import { GitHubAppsClientLive } from "./github-apps.client-live.ts";

// An App's key pair, made with the runtime's Web Crypto: the private key as
// GitHub hands it over, PEM-encoded, and the public key to check what it signed.
const RSA = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

const keyPair = Effect.gen(function* () {
  const keys = yield* Effect.promise(() =>
    crypto.subtle.generateKey(RSA, true, ["sign", "verify"]),
  );

  const der = yield* Effect.promise(() => crypto.subtle.exportKey("pkcs8", keys.privateKey));

  const pem = [
    "-----BEGIN PRIVATE KEY-----",
    ...(Buffer.from(der)
      .toString("base64")
      .match(/.{1,64}/g) ?? []),
    "-----END PRIVATE KEY-----",
    "",
  ].join("\n");

  return { publicKey: keys.publicKey, pem };
});

const Claims = Schema.fromJsonString(Schema.Struct({ iss: Schema.String }));

type Json = Schema.Json;

const printed = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

type Sent = {
  readonly method: string;
  readonly url: string;
  readonly authorization: Option.Option<string>;
};

// The App's own calls: GitHub as it answers them, by method and path.
const appApi = (sent: Array<Sent>, answers: Readonly<Record<string, [number, Json]>>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      sent.push({
        method: request.method,
        url: request.url,
        authorization: Option.fromUndefinedOr(request.headers.authorization),
      });

      const [status, body] = answers[`${request.method} ${new URL(request.url).pathname}`] ?? [
        404,
        { message: "Not Found" },
      ];

      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(printed(body), { status })),
      );
    }),
  );

type Asked = {
  readonly method: string;
  readonly path: string;
  readonly body: Option.Option<unknown>;
};

// The person's calls: GitHub as it answers them, by method and path.
const personApi = (asked: Array<Asked>, answers: Readonly<Record<string, [number, Json]>>) =>
  Layer.succeed(
    GitHubApi,
    GitHubApi.of({
      request: (method, path, body) =>
        Effect.sync(() => {
          asked.push({ method, path, body });
          const [status, answer] = answers[`${method} ${path}`] ?? [200, {}];

          return {
            status,
            body: Option.some(answer),
            nextUrl: Option.none(),
            headers: {},
          };
        }),
    }),
  );

type GhCall = { readonly args: ReadonlyArray<string>; readonly options: ExecOptions };

const gh = (calls: Array<GhCall>) =>
  execTestLayer((command, args, options) => {
    if (command !== "gh") {
      return Option.none();
    }

    calls.push({ args, options });

    return Option.some({ exitCode: 0, stdout: "", stderr: "" });
  });

const effect = effectAtHomeWith(Layer.empty);

const clientWith = (layers: Layer.Layer<HttpClient.HttpClient | GitHubApi | Exec>) =>
  Effect.provide(GitHubAppsClientLive.pipe(Layer.provide(layers)));

describe("GitHubAppsClientLive", () => {
  effect("trades a manifest's code for the App, asking with no token", () => {
    const sent: Array<Sent> = [];

    return Effect.gen(function* () {
      const app = yield* (yield* GitHubAppsClient).convertManifest("abc");

      expect(app).toEqual({ id: "101", slug: "acme-chernabog-author", privateKey: "PEM" });
      expect(sent).toEqual([
        {
          method: "POST",
          url: "https://api.github.com/app-manifests/abc/conversions",
          authorization: Option.none(),
        },
      ]);

      const expired = yield* Effect.flip((yield* GitHubAppsClient).convertManifest("old"));

      expect(expired.message).toContain("a code lasts an hour");
    }).pipe(
      clientWith(
        Layer.mergeAll(
          appApi(sent, {
            "POST /app-manifests/abc/conversions": [
              201,
              { id: 101, slug: "acme-chernabog-author", pem: "PEM", client_secret: "x" },
            ],
          }),
          personApi([], {}),
          gh([]),
        ),
      ),
    );
  });

  effect("finds the App's installation on a repo as the App, by its signed JWT", () => {
    const sent: Array<Sent> = [];

    return Effect.gen(function* () {
      const apps = yield* GitHubAppsClient;
      const keys = yield* keyPair;
      const app = { id: "101", privateKey: keys.pem };

      expect(yield* apps.installationOn(app, "acme/widgets")).toEqual(Option.some("201"));
      expect(yield* apps.installationOn(app, "acme/elsewhere")).toEqual(Option.none());

      const [header, payload, signature] = Option.getOrElse(sent[0].authorization, () => "")
        .replace("Bearer ", "")
        .split(".");

      const verified = yield* Effect.promise(() =>
        crypto.subtle.verify(
          RSA,
          keys.publicKey,
          Buffer.from(signature, "base64url"),
          new TextEncoder().encode(`${header}.${payload}`),
        ),
      );

      expect(verified).toBe(true);

      const claims = yield* Schema.decodeEffect(Claims)(
        Buffer.from(payload, "base64url").toString(),
      );

      expect(claims.iss).toBe("101");
    }).pipe(
      clientWith(
        Layer.mergeAll(
          appApi(sent, { "GET /repos/acme/widgets/installation": [200, { id: 201 }] }),
          personApi([], {}),
          gh([]),
        ),
      ),
    );
  });

  effect("an App GitHub hasn't taken the key of yet is not ready, not failed", () =>
    Effect.gen(function* () {
      const keys = yield* keyPair;

      const error = yield* Effect.flip(
        (yield* GitHubAppsClient).installationOn(
          { id: "102", privateKey: keys.pem },
          "acme/widgets",
        ),
      );

      expect(error._tag).toBe("AppKeyNotReady");
    }).pipe(
      clientWith(
        Layer.mergeAll(
          appApi([], {
            "GET /repos/acme/widgets/installation": [
              401,
              { message: "Integration must generate a public key", status: "401" },
            ],
          }),
          personApi([], {}),
          gh([]),
        ),
      ),
    ),
  );

  effect("describes the App as GitHub has it now, asked as the App", () => {
    const sent: Array<Sent> = [];

    return Effect.gen(function* () {
      const keys = yield* keyPair;

      const app = yield* (yield* GitHubAppsClient).describeApp({
        id: "102",
        privateKey: keys.pem,
      });

      expect(app).toEqual({
        slug: "quail-gatekeeper",
        owner: "DataQuail",
        permissions: { checks: "write", contents: "write" },
      });
      expect(sent.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
        "GET /app",
      ]);
      expect(Option.getOrElse(sent[0].authorization, () => "")).toStartWith("Bearer ey");
    }).pipe(
      clientWith(
        Layer.mergeAll(
          appApi(sent, {
            "GET /app": [
              200,
              {
                id: 102,
                slug: "quail-gatekeeper",
                name: "Quail Gatekeeper",
                owner: { login: "DataQuail", type: "Organization" },
                permissions: { checks: "write", contents: "write" },
              },
            ],
          }),
          personApi([], {}),
          gh([]),
        ),
      ),
    );
  });

  effect("lists the repos an installation covers, as the installation's own token", () => {
    const sent: Array<Sent> = [];

    return Effect.gen(function* () {
      const keys = yield* keyPair;

      const repos = yield* (yield* GitHubAppsClient).repositoriesOf(
        { id: "101", privateKey: keys.pem },
        "201",
      );

      expect(repos).toEqual(["acme/widgets", "acme/gadgets"]);
      expect(sent.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
        "POST /app/installations/201/access_tokens",
        "GET /installation/repositories",
      ]);
      expect(sent[1].authorization).toEqual(Option.some("Bearer ghs_installation"));
    }).pipe(
      clientWith(
        Layer.mergeAll(
          appApi(sent, {
            "POST /app/installations/201/access_tokens": [
              201,
              { token: "ghs_installation", expires_at: "2099-01-01T00:00:00Z" },
            ],
            "GET /installation/repositories": [
              200,
              {
                total_count: 2,
                repositories: [{ full_name: "acme/widgets" }, { full_name: "acme/gadgets" }],
              },
            ],
          }),
          personApi([], {}),
          gh([]),
        ),
      ),
    );
  });

  effect("tells an organization from a user, as the person", () =>
    Effect.gen(function* () {
      const apps = yield* GitHubAppsClient;

      expect(yield* apps.ownerIsOrganization("acme")).toBe(true);
      expect(yield* apps.ownerIsOrganization("alice")).toBe(false);
    }).pipe(
      clientWith(
        Layer.mergeAll(
          appApi([], {}),
          personApi([], {
            "GET /users/acme": [200, { type: "Organization" }],
            "GET /users/alice": [200, { type: "User" }],
          }),
          gh([]),
        ),
      ),
    ),
  );

  effect(
    "keeps the reviewer's Environment to the default branch, updates a variable there, and hands gh the key on stdin",
    () => {
      const asked: Array<Asked> = [];
      const calls: Array<GhCall> = [];
      const environment = "/repos/acme/widgets/environments/chernabog-review";

      return Effect.gen(function* () {
        yield* (yield* GitHubAppsClient).provisionEnvironment({
          repo: "acme/widgets",
          name: "chernabog-review",
          defaultBranchOnly: true,
          variables: { CHERNABOG_APP_ID: "102" },
          secrets: { CHERNABOG_APP_KEY: "PEM" },
        });

        expect(asked.map((call) => `${call.method} ${call.path}`)).toEqual([
          `PUT ${environment}`,
          "GET /repos/acme/widgets",
          `GET ${environment}/deployment-branch-policies`,
          `POST ${environment}/deployment-branch-policies`,
          `POST ${environment}/variables`,
          `PATCH ${environment}/variables/CHERNABOG_APP_ID`,
        ]);
        expect(asked[0].body).toEqual(
          Option.some({
            deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
          }),
        );
        expect(asked[3].body).toEqual(Option.some({ name: "main", type: "branch" }));
        expect(calls).toEqual([
          {
            args: [
              "secret",
              "set",
              "CHERNABOG_APP_KEY",
              "--env",
              "chernabog-review",
              "--repo",
              "acme/widgets",
            ],
            options: { stdin: "PEM" },
          },
        ]);
      }).pipe(
        clientWith(
          Layer.mergeAll(
            appApi([], {}),
            personApi(asked, {
              [`PUT ${environment}`]: [200, {}],
              "GET /repos/acme/widgets": [200, { default_branch: "main" }],
              [`GET ${environment}/deployment-branch-policies`]: [200, { branch_policies: [] }],
              [`POST ${environment}/deployment-branch-policies`]: [200, {}],
              [`POST ${environment}/variables`]: [409, { message: "Already exists" }],
            }),
            gh(calls),
          ),
        ),
      );
    },
  );

  effect("lets the author's Environment be used from any branch", () => {
    const asked: Array<Asked> = [];

    return Effect.gen(function* () {
      yield* (yield* GitHubAppsClient).provisionEnvironment({
        repo: "acme/widgets",
        name: "chernabog-author",
        defaultBranchOnly: false,
        variables: {},
        secrets: {},
      });

      expect(asked).toEqual([
        {
          method: "PUT",
          path: "/repos/acme/widgets/environments/chernabog-author",
          body: Option.some({}),
        },
      ]);
    }).pipe(clientWith(Layer.mergeAll(appApi([], {}), personApi(asked, {}), gh([]))));
  });
});
