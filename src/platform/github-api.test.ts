import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../test/effect-test.ts";
import { IMPLICIT, type Persona } from "../kernel/persona.value-object.ts";
import { viewerAs } from "./github-api.ts";
import { GitHubTokens } from "./github-auth.ts";

type Asked = { readonly url: string; readonly authorization: string };

// An API that answers every request with one account, and remembers what it was asked.
const answering = (asked: Array<Asked>, account: { login: string; id: number }) =>
  Layer.mergeAll(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        asked.push({ url: request.url, authorization: request.headers.authorization });

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ ...account, type: "Bot" }), { status: 200 }),
          ),
        );
      }),
    ),
    GitHubTokens.fixed("implicit-token"),
  );

// The account viewerAs reads for a persona, from an API that answers with `account`.
const viewerFrom = (
  persona: Persona,
  asked: Array<Asked>,
  account: { login: string; id: number },
) => Effect.provide(viewerAs(persona), answering(asked, account));

effect("a named persona's account is read by its login, encoded, with its own token", () =>
  Effect.gen(function* () {
    const asked: Array<Asked> = [];

    const viewer = yield* viewerFrom(Option.some("acme-review[bot]"), asked, {
      login: "acme-review[bot]",
      id: 4242,
    });

    expect(viewer).toEqual({ login: "acme-review[bot]", id: 4242 });
    expect(asked).toEqual([
      {
        url: "https://api.github.com/users/acme-review%5Bbot%5D",
        authorization: "Bearer token-acme-review[bot]",
      },
    ]);
  }),
);

effect("the implicit persona's account is its token's, from /user", () =>
  Effect.gen(function* () {
    const asked: Array<Asked> = [];

    const viewer = yield* viewerFrom(IMPLICIT, asked, { login: "octocat", id: 1 });

    expect(viewer).toEqual({ login: "octocat", id: 1 });
    expect(asked).toEqual([
      { url: "https://api.github.com/user", authorization: "Bearer implicit-token" },
    ]);
  }),
);
