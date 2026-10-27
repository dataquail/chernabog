import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { GitHubApi } from "../../../../platform/github-api.ts";
import { ViewerClient } from "../../domain/ports/clients/viewer.client.ts";
import { ViewerClientLive } from "./viewer.client-live.ts";

// GitHub answering /user, or failing.
const github = (status: number) =>
  Layer.succeed(
    GitHubApi,
    GitHubApi.of({
      request: () =>
        Effect.succeed({
          status,
          body: Option.some({ login: "carol" }),
          nextUrl: Option.none(),
          headers: {},
        }),
    }),
  );

describe("ViewerClientLive", () => {
  effect("is the login GitHub says the ambient token belongs to", () =>
    Effect.gen(function* () {
      expect(yield* (yield* ViewerClient).login).toEqual(Option.some("carol"));
    }).pipe(Effect.provide(ViewerClientLive.pipe(Layer.provide(github(200))))),
  );

  effect("is none when GitHub won't say", () =>
    Effect.gen(function* () {
      expect(yield* (yield* ViewerClient).login).toEqual(Option.none());
    }).pipe(Effect.provide(ViewerClientLive.pipe(Layer.provide(github(401))))),
  );
});
