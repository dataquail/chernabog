import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { effect } from "../../../../test/effect-test.ts";
import { AppKeysClientFake } from "../infrastructure/clients/app-keys.client-fake.ts";
import { GitHubAppsClientFake } from "../infrastructure/clients/github-apps.client-fake.ts";
import { createAppHandler } from "./create-app.handler.ts";

describe("createAppHandler", () => {
  effect("keeps the key of the App a code made, and says where to install it", () => {
    const keys = new Map<string, string>();

    return Effect.gen(function* () {
      const app = yield* createAppHandler({ code: "abc" });

      expect(app).toMatchObject({
        id: "101",
        slug: "acme-chernabog-author",
        login: "acme-chernabog-author[bot]",
        key: "~/keys/acme-chernabog-author.pem",
        installUrl: "https://github.com/apps/acme-chernabog-author/installations/new",
      });
      expect(keys.get(app.key)).toBe("PEM");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          PassThroughUnitOfWork,
          AppKeysClientFake(keys),
          GitHubAppsClientFake({
            codes: { abc: { id: "101", slug: "acme-chernabog-author", privateKey: "PEM" } },
          }),
        ),
      ),
    );
  });

  effect("a code GitHub doesn't know keeps no key", () => {
    const keys = new Map<string, string>();

    return Effect.gen(function* () {
      const error = yield* Effect.flip(createAppHandler({ code: "stale" }));

      expect(error._tag).toBe("GitHubAppsFailed");
      expect(keys.size).toBe(0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(PassThroughUnitOfWork, AppKeysClientFake(keys), GitHubAppsClientFake()),
      ),
    );
  });
});
