import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { effectAtHome } from "../../../../../test/effect-test.ts";
import { Home, homePaths } from "../../../../platform/home.ts";
import { AppKeysClient } from "../../domain/ports/clients/app-keys.client.ts";
import { AppKeysClientLive } from "./app-keys.client-live.ts";

describe("AppKeysClientLive", () => {
  effectAtHome("writes a key only the person may read, and reads it back by its path", () =>
    Effect.gen(function* () {
      const keys = yield* AppKeysClient;
      const fs = yield* FileSystem.FileSystem;
      const home = yield* Home;

      const path = yield* keys.write("acme-chernabog-author", "-----BEGIN KEY-----\n");
      const file = homePaths(home.root).appKey("acme-chernabog-author");

      expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
      expect((yield* fs.stat(file.slice(0, file.lastIndexOf("/")))).mode & 0o777).toBe(0o700);
      expect(yield* keys.read(path)).toBe("-----BEGIN KEY-----\n");

      yield* keys.write("acme-chernabog-author", "-----BEGIN NEWER KEY-----\n");
      expect(yield* keys.read(path)).toBe("-----BEGIN NEWER KEY-----\n");
    }).pipe(Effect.provide(Layer.fresh(AppKeysClientLive))),
  );
});
