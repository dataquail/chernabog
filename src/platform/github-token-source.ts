// Where a GitHub persona's token comes from (#477): gh's login for it, an
// environment variable, or a GitHub App's installation. An App's token is made
// from its id and private key, lasts an hour, and GitHubTokens makes a new one
// before it runs out. The App's login is `<slug>[bot]`, the persona's key
// under machine config's github:.

import { createSign } from "node:crypto";

import { GitHubError } from "@chernabog/core";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";

export type AppSource = {
  readonly kind: "app";
  readonly id: string;
  readonly installation: string;
  // The App's private key, PEM-encoded.
  readonly privateKey: string;
};

export type TokenSource =
  { readonly kind: "gh" } | { readonly kind: "env"; readonly variable: string } | AppSource;

export const GH_SOURCE: TokenSource = { kind: "gh" };

// Each persona's source, by login. Without one provided, every persona's is gh.
export class TokenSources extends Context.Service<
  TokenSources,
  {
    sourceOf(login: string): Effect.Effect<TokenSource, GitHubError>;
  }
>()("chernabog/TokenSources") {}

// A token and when to look for a new one.
export type FoundToken = { readonly token: string; readonly refreshIn: Duration.Duration };

// How long a token whose expiry isn't known is kept: a gh login can be refreshed under us.
export const UNEXPIRING_REFRESH = Duration.minutes(30);

// How long before an installation token expires a new one is made.
export const EXPIRY_MARGIN = Duration.minutes(5);

const base64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

// The JWT a GitHub App signs to ask for an installation token: issued a minute
// ago against clock drift, and good for nine minutes, under GitHub's ten.
export const appJwt = (appId: string, privateKey: string, nowSeconds: number) => {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));

  const payload = base64url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);

  return `${header}.${payload}.${base64url(signer.sign(privateKey))}`;
};

const InstallationToken = Schema.Struct({ token: Schema.String, expires_at: Schema.String });

// When to make a new token for one that expires at `expiresAt`: a margin
// before then, and never sooner than ten seconds from now.
export const refreshBefore = (now: DateTime.Utc, expiresAt: DateTime.Utc) =>
  Duration.millis(
    Math.max(
      DateTime.toEpochMillis(expiresAt) -
        DateTime.toEpochMillis(now) -
        Duration.toMillis(EXPIRY_MARGIN),
      10_000,
    ),
  );

// An installation token for the App, from GitHub's API (CHERNABOG_GITHUB_API moves it).
export const installationToken = (source: AppSource) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const root = yield* Config.String("CHERNABOG_GITHUB_API").pipe(
      Config.withDefault("https://api.github.com"),
    );

    const now = yield* DateTime.now;

    const jwt = yield* Effect.try({
      try: () =>
        appJwt(source.id, source.privateKey, Math.floor(DateTime.toEpochMillis(now) / 1000)),
      catch: (error) =>
        new GitHubError({ message: `signing as App ${source.id}: ${String(error)}` }),
    });

    const request = HttpClientRequest.post(
      `${root}/app/installations/${source.installation}/access_tokens`,
    ).pipe(
      HttpClientRequest.bearerToken(jwt),
      HttpClientRequest.setHeaders({
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      }),
    );

    const response = yield* client.execute(request);
    const text = yield* response.text;

    if (response.status !== 201) {
      return yield* new GitHubError({
        message: `App ${source.id}'s installation ${source.installation} gave no token: HTTP ${response.status} ${text}`,
      });
    }

    const body = yield* Schema.decodeEffect(Schema.fromJsonString(InstallationToken))(text);
    const expiresAt = yield* Effect.fromOption(DateTime.make(body.expires_at));

    return { token: body.token, refreshIn: refreshBefore(now, expiresAt) } satisfies FoundToken;
  }).pipe(
    Effect.mapError((error) => {
      if (error instanceof GitHubError) {
        return error;
      }

      return new GitHubError({
        message: `App ${source.id}'s installation token: ${error.message}`,
      });
    }),
  );

// The machine config shape of a persona's token source, under github.<login>.token.
export const TokenSourceFile = Schema.Union([
  Schema.Literal("gh"),
  Schema.Struct({ env: Schema.String }),
  Schema.Struct({
    app: Schema.Struct({
      id: Schema.Union([Schema.String, Schema.Int]),
      installation: Schema.Union([Schema.String, Schema.Int]),
      // A path to the App's private key file; the key itself never sits in config.
      key: Schema.String,
    }),
  }),
]);

export type TokenSourceFile = typeof TokenSourceFile.Type;
