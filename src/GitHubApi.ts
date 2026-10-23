// GitHub's REST and GraphQL APIs, authenticated as one GitHub persona (see
// github-auth.ts). Bodies come back as JSON for the caller to decode with its
// own schema.

import { GitHubError, type Json, printJson } from "@chernabog/sdk";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpMethod from "effect/http/HttpMethod";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { GitHubTokens } from "./github-auth.ts";
import { IMPLICIT, type Persona } from "./persona.ts";

export { GitHubError };

// A 204 and the like have no body.
export type GithubResponse = {
  readonly status: number;
  readonly body: Option.Option<Json>;
  readonly nextUrl: Option.Option<string>;
};

const nextPageUrl = (linkHeader: string) =>
  Option.fromNullishOr(/<([^>]+)>;\s*rel="next"/.exec(linkHeader)).pipe(
    Option.map((match) => match[1]),
  );

export class GitHubApi extends Context.Service<
  GitHubApi,
  {
    request(
      method: HttpMethod.HttpMethod,
      pathOrUrl: string,
      body: Option.Option<Json>,
    ): Effect.Effect<GithubResponse, GitHubError>;
  }
>()("chernabog/GitHubApi") {
  // The API as one persona: its token comes from GitHubTokens, on the first
  // request that needs it.
  public static readonly layerFor = (
    persona: Persona,
  ): Layer.Layer<GitHubApi, never, GitHubTokens | HttpClient.HttpClient> =>
    Layer.effect(
      GitHubApi,
      Effect.gen(function* () {
        const tokens = yield* GitHubTokens;
        const client = yield* HttpClient.HttpClient;

        // CHERNABOG_GITHUB_API points at another API, such as GitHub Enterprise or a test server.
        const root = yield* Config.String("CHERNABOG_GITHUB_API").pipe(
          Config.withDefault("https://api.github.com"),
        );

        const token = tokens.token(persona);

        const request = (
          method: HttpMethod.HttpMethod,
          pathOrUrl: string,
          body: Option.Option<Json>,
        ) =>
          Effect.gen(function* () {
            let url = `${root}${pathOrUrl}`;

            if (/^https?:\/\//.test(pathOrUrl)) {
              url = pathOrUrl;
            }

            const base = HttpClientRequest.make(method)(url).pipe(
              HttpClientRequest.bearerToken(yield* token),
              HttpClientRequest.setHeaders({
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
              }),
            );

            const withBody = Option.match(body, {
              onNone: () => base,
              onSome: (json) => HttpClientRequest.bodyJsonUnsafe(base, json),
            });

            const response = yield* client.execute(withBody);
            const text = yield* response.text;
            let parsed = Option.none<Json>();

            if (text.length > 0) {
              parsed = Option.some(
                yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(text),
              );
            }

            return {
              status: response.status,
              body: parsed,
              nextUrl: Option.flatMap(Headers.get(response.headers, "link"), nextPageUrl),
            };
          }).pipe(
            Effect.mapError(
              (error) => new GitHubError({ message: `${method} ${pathOrUrl}: ${error.message}` }),
            ),
            // GitHub answers a 5xx now and then; a network error or one of those is worth two more tries.
            Effect.filterOrFail(
              (response) => response.status < 500,
              (response) =>
                new GitHubError({
                  message: `${method} ${pathOrUrl} returned HTTP ${response.status}`,
                }),
            ),
            Effect.retry({ schedule: Schedule.exponential("1 second"), times: 2 }),
          );

        return GitHubApi.of({ request });
      }).pipe(Effect.orDie),
    );

  // The API as whoever the daemon is (GH_TOKEN, then GITHUB_TOKEN, then gh's active account).
  public static readonly layer = GitHubApi.layerFor(IMPLICIT).pipe(
    Layer.provide(GitHubTokens.layer),
  );
}

export const githubRequest = (
  method: HttpMethod.HttpMethod,
  pathOrUrl: string,
  body: Option.Option<Json> = Option.none(),
) => GitHubApi.use((api) => api.request(method, pathOrUrl, body));

const describeBody = (body: Option.Option<Json>) =>
  Option.match(body, { onNone: () => "no body", onSome: printJson });

// A request that must succeed, for its status alone.
export const githubSend = (
  method: HttpMethod.HttpMethod,
  path: string,
  body: Option.Option<Json> = Option.none(),
) =>
  githubRequest(method, path, body).pipe(
    Effect.filterOrFail(
      (response) => response.status < 300,
      (response) =>
        new GitHubError({
          message: `${method} ${path} returned HTTP ${response.status}: ${describeBody(response.body)}`,
        }),
    ),
  );

// A body read into a schema's type.
export const decodeBody =
  <A>(schema: Schema.Codec<A, Json>, what: string) =>
  (body: Option.Option<Json>) =>
    Option.match(body, {
      onNone: () => Effect.fail(new GitHubError({ message: `${what}: no response body` })),
      onSome: (json) =>
        Schema.decodeEffect(schema)(json).pipe(
          Effect.mapError(
            (issue) =>
              new GitHubError({ message: `${what}: unexpected response: ${issue.message}` }),
          ),
        ),
    });

// A request that must succeed, its body read into a schema's type.
export const githubJson = <A>(
  method: HttpMethod.HttpMethod,
  path: string,
  schema: Schema.Codec<A, Json>,
  body: Option.Option<Json> = Option.none(),
) =>
  githubSend(method, path, body).pipe(
    Effect.flatMap((response) => decodeBody(schema, `${method} ${path}`)(response.body)),
  );

const GraphqlResponse = Schema.Struct({
  data: Schema.optionalKey(Schema.Json),
  errors: Schema.optionalKey(Schema.Array(Schema.Json)),
});

export const githubGraphql = <A>(
  query: string,
  variables: Readonly<Record<string, Json>>,
  data: Schema.Codec<A, Json>,
) =>
  Effect.gen(function* () {
    const response = yield* githubJson(
      "POST",
      "/graphql",
      GraphqlResponse,
      Option.some({ query, variables }),
    );

    const errors = Option.fromUndefinedOr(response.errors).pipe(
      Option.filter((found) => found.length > 0),
    );

    if (Option.isSome(errors)) {
      return yield* new GitHubError({
        message: `GraphQL query failed: ${printJson(errors.value)}`,
      });
    }

    return yield* decodeBody(data, "GraphQL data")(Option.fromUndefinedOr(response.data));
  });

// Every page of a list endpoint. `Page` reads one page; `itemsOf` picks its items, when the list sits inside it.
export const githubGetAllPages = <P, A>(
  path: string,
  Page: Schema.Codec<P, Json>,
  itemsOf: (page: P) => ReadonlyArray<A>,
) =>
  Effect.gen(function* () {
    const items: Array<A> = [];
    let url = Option.some(path);

    while (Option.isSome(url)) {
      const response = yield* githubSend("GET", url.value);

      for (const item of itemsOf(yield* decodeBody(Page, `GET ${url.value}`)(response.body))) {
        items.push(item);
      }

      url = response.nextUrl;
    }

    return items;
  });

// A fake for tests: answers each request from the handler, as an HTTP status and body.
export const githubTestLayer = (
  handler: (
    method: string,
    path: string,
    body: Option.Option<Json>,
  ) => Option.Option<{ status: number; body: Json }>,
) =>
  Layer.succeed(
    GitHubApi,
    GitHubApi.of({
      request: (method, path, body) =>
        Option.match(handler(method, path, body), {
          onNone: () =>
            Effect.fail(new GitHubError({ message: `no fake answers ${method} ${path}` })),
          onSome: (answer) =>
            Effect.succeed({
              status: answer.status,
              body: Option.some(answer.body),
              nextUrl: Option.none<string>(),
            }),
        }),
    }),
  );

// The GitHub login of the token this machine uses.
export const viewerLogin = githubJson("GET", "/user", Schema.Struct({ login: Schema.String })).pipe(
  Effect.map((user) => user.login),
);

// The GitHub login a persona's token belongs to.
export const viewerLoginAs = (persona: Persona) =>
  Layer.build(GitHubApi.layerFor(persona)).pipe(
    Effect.flatMap((api) => Effect.provideContext(viewerLogin, api)),
    Effect.scoped,
  );

const Permission = Schema.Struct({
  permission: Schema.String,
  role_name: Schema.optionalKey(Schema.String),
});

// Whether a login can push to and merge in a repo: write, maintain or admin.
// Asked as that login, whose token can read its own permission.
export const canMerge = (slug: string, login: string) =>
  Layer.build(GitHubApi.layerFor(Option.some(login))).pipe(
    Effect.flatMap((api) =>
      Effect.provideContext(
        githubJson("GET", `/repos/${slug}/collaborators/${login}/permission`, Permission),
        api,
      ),
    ),
    Effect.map((found) => ({
      ok: ["admin", "maintain", "write"].includes(found.role_name ?? found.permission),
      permission: found.role_name ?? found.permission,
    })),
    Effect.scoped,
  );
