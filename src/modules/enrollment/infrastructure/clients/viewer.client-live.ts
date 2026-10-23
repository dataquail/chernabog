// The implicit persona's login, from GitHub's /user for the ambient token.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GitHubApi, viewerLogin } from "../../../../platform/github-api.ts";
import { ViewerClient } from "../../domain/ports/clients/viewer.client.ts";

export const ViewerClientLive = Layer.effect(
  ViewerClient,
  Effect.gen(function* () {
    const api = yield* GitHubApi;

    return ViewerClient.of({
      login: Effect.option(viewerLogin).pipe(Effect.provideService(GitHubApi, api)),
    });
  }),
);
