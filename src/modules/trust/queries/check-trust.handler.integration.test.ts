import { BunServices } from "@effect/platform-bun";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effectAtHomeWith } from "../../../../test/effect-test.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { Exec, execOk } from "../../../platform/exec.ts";
import { TrustRecordsRepository } from "../domain/ports/repositories/trust-records.repository.ts";
import { TrustRecordRoot } from "../domain/trust-record/trust-record.root.ts";
import { ConfigTreeClientLive } from "../infrastructure/clients/config-tree.client-live.ts";
import { TrustRecordsRepositoryLive } from "../infrastructure/repositories/trust-records.repository-live.ts";
import { checkTrustHandler } from "./check-trust.handler.ts";

const repo = RepoSlug.make("dataquail/demo");

const git = (path: string, ...args: ReadonlyArray<string>) =>
  execOk("git", ["-C", path, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args]);

// A checkout on main, with .chernabog/config.yaml holding `config` when given.
const checkout = (config: Option.Option<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-trust-" });

    yield* git(path, "init", "--quiet", "--initial-branch", "main");

    if (Option.isSome(config)) {
      yield* fs.makeDirectory(`${path}/.chernabog`, { recursive: true });
      yield* fs.writeFileString(`${path}/.chernabog/config.yaml`, config.value);
      yield* git(path, "add", ".");
    }

    yield* git(path, "commit", "--quiet", "--allow-empty", "-m", "init");

    return path;
  });

const treeOf = (path: string) =>
  git(path, "rev-parse", "main:.chernabog").pipe(Effect.map((tree) => tree.trim()));

// Trusts the tree of .chernabog/ in `path`, as trust.json records it.
const trust = (path: string) =>
  Effect.gen(function* () {
    const tree = yield* treeOf(path);
    yield* (yield* TrustRecordsRepository).save(
      TrustRecordRoot.make({ repo, tree, at: "2026-10-01T00:00:00.000Z" }),
    );

    return tree;
  });

const check = (path: string) => checkTrustHandler({ repo, path });

// git runs for real.
const effect = effectAtHomeWith(Exec.layer.pipe(Layer.provide(BunServices.layer)));

// trust.json in the scratch home, and .chernabog/ read through git.
const checking = Layer.mergeAll(TrustRecordsRepositoryLive, ConfigTreeClientLive);

describe("checkTrustHandler", () => {
  effect("is trusted while the tree on the base branch is the one trusted", () =>
    Effect.gen(function* () {
      const trustedPath = yield* checkout(Option.some("schedule: hourly\n"));
      const changedPath = yield* checkout(Option.some("schedule: daily\n"));
      const tree = yield* trust(trustedPath);
      const changedTree = yield* treeOf(changedPath);

      const trusted = yield* check(trustedPath);
      const changed = yield* check(changedPath);

      expect([trusted.tree, trusted.trusted]).toEqual([Option.some(tree), true]);
      expect([changed.tree, changed.trusted]).toEqual([Option.some(changedTree), false]);
      expect(changedTree).not.toBe(tree);
    }).pipe(Effect.provide(checking)),
  );

  effect("has no tree, and isn't trusted, without a .chernabog/ on the base branch", () =>
    Effect.gen(function* () {
      yield* trust(yield* checkout(Option.some("schedule: hourly\n")));
      const found = yield* check(yield* checkout(Option.none()));

      expect([found.tree, found.trusted]).toEqual([Option.none(), false]);
    }).pipe(Effect.provide(checking)),
  );
});
