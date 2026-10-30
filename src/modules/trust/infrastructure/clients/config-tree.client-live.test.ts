import { BunServices } from "@effect/platform-bun";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effectAtHomeWith } from "../../../../../test/effect-test.ts";
import { Exec, execOk } from "../../../../platform/exec.ts";
import { ConfigTreeClient } from "../../domain/ports/clients/config-tree.client.ts";
import { ConfigTreeClientLive } from "./config-tree.client-live.ts";

const gitIn =
  (path: string) =>
  (...args: ReadonlyArray<string>) =>
    execOk("git", [
      "-C",
      path,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      ...args,
    ]);

// A repo on main with .chernabog/ committed, and a client over it.
const checkout = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-trust-" });
  const git = gitIn(path);

  yield* git("init", "--quiet", "--initial-branch", "main");
  yield* fs.makeDirectory(`${path}/.chernabog/flows`, { recursive: true });
  yield* fs.writeFileString(`${path}/.chernabog/config.yaml`, "schedule: hourly\n");
  yield* fs.writeFileString(`${path}/.chernabog/flows/implement.ts`, "export {};\n");
  yield* git("add", ".");
  yield* git("commit", "--quiet", "-m", "init");

  return { fs, git, path, client: yield* ConfigTreeClient };
}).pipe(Effect.provide(ConfigTreeClientLive));

// An origin whose default branch is trunk, with another .chernabog/ on
// develop, and a clone of it.
const cloned = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const origin = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-origin-" });
  const path = `${yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-clone-" })}/demo`;
  const git = gitIn(origin);

  yield* git("init", "--quiet", "--initial-branch", "trunk");
  yield* fs.makeDirectory(`${origin}/.chernabog`, { recursive: true });
  yield* fs.writeFileString(`${origin}/.chernabog/config.yaml`, "schedule: hourly\n");
  yield* git("add", ".");
  yield* git("commit", "--quiet", "-m", "trunk");
  yield* git("checkout", "--quiet", "-b", "develop");
  yield* fs.writeFileString(`${origin}/.chernabog/config.yaml`, "schedule: daily\n");
  yield* git("commit", "--quiet", "-am", "develop");
  yield* git("checkout", "--quiet", "trunk");
  yield* execOk("git", ["clone", "--quiet", origin, path]);

  const treeOn = (branch: string) =>
    git("rev-parse", `${branch}:.chernabog`).pipe(Effect.map((tree) => tree.trim()));

  return { git, origin, path, treeOn, client: yield* ConfigTreeClient };
}).pipe(Effect.provide(ConfigTreeClientLive));

// git runs for real.
const effect = effectAtHomeWith(Exec.layer.pipe(Layer.provide(BunServices.layer)));

describe("ConfigTreeClientLive", () => {
  effect(
    "reads the tree of .chernabog/ on the default branch, and lists every file the first time",
    () =>
      Effect.gen(function* () {
        const { client, path } = yield* checkout;
        const tree = yield* client.treeOf(path);

        expect(tree).toMatch(/^[0-9a-f]{40}$/);
        expect(yield* client.changesSince(path, Option.none(), tree)).toBe(
          "first trust; .chernabog/ holds:\n  config.yaml\n  flows/implement.ts",
        );
      }),
  );

  effect("shows what changed since the tree trusted before, or that nothing did", () =>
    Effect.gen(function* () {
      const { client, fs, git, path } = yield* checkout;
      const before = yield* client.treeOf(path);
      yield* fs.writeFileString(`${path}/.chernabog/config.yaml`, "schedule: daily\n");
      yield* git("commit", "--quiet", "-am", "change");
      const after = yield* client.treeOf(path);

      expect(yield* client.changesSince(path, Option.some(before), after)).toContain(
        "-schedule: hourly\n+schedule: daily",
      );
      expect(yield* client.changesSince(path, Option.some(after), after)).toBe("no changes");
    }),
  );

  effect("reads the same tree as git has it, without a remote to fetch from", () =>
    Effect.gen(function* () {
      const { client, path } = yield* checkout;

      expect(yield* client.localTreeOf(path)).toBe(yield* client.treeOf(path));
    }),
  );

  effect("reads the branch GitHub names its default, whatever the checkout has out", () =>
    Effect.gen(function* () {
      const { client, path, treeOn } = yield* cloned;
      yield* gitIn(path)("checkout", "--quiet", "develop");

      expect(yield* client.treeOf(path)).toBe(yield* treeOn("trunk"));
    }),
  );

  effect("follows a change of default branch on the remote, without re-enrolling", () =>
    Effect.gen(function* () {
      const { client, git, path, treeOn } = yield* cloned;
      yield* client.treeOf(path);
      yield* git("symbolic-ref", "HEAD", "refs/heads/develop");

      expect(yield* client.treeOf(path)).toBe(yield* treeOn("develop"));
      // What the snapshot asked of the remote is what a read without it finds.
      expect(yield* client.localTreeOf(path)).toBe(yield* treeOn("develop"));
    }),
  );

  effect("fails saying what to do when the default branch has no .chernabog/", () =>
    Effect.gen(function* () {
      const { client, git, path } = yield* checkout;
      yield* git("checkout", "--quiet", "--orphan", "bare");
      yield* git("rm", "-rq", "--cached", ".");
      yield* git("branch", "-D", "main");
      yield* git("commit", "--quiet", "--allow-empty", "-m", "empty");
      yield* git("branch", "-m", "main");
      const refused = yield* Effect.flip(client.treeOf(path));

      expect(refused.message).toBe(
        `${path}: no .chernabog/ on main, GitHub's default branch; run chernabog init and merge it first`,
      );
    }),
  );
});
