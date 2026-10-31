import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { TrustRecordRoot } from "../domain/trust-record/trust-record.root.ts";
import { ConfigTreeClientFake } from "../infrastructure/clients/config-tree.client-fake.ts";
import { TrustRecordsRepositoryFake } from "../infrastructure/repositories/trust-records.repository-fake.ts";
import { checkTrustHandler } from "./check-trust.handler.ts";

const repo = RepoSlug.make("dataquail/demo");

const checking = (trees: Readonly<Record<string, string>>) =>
  Layer.mergeAll(
    ConfigTreeClientFake(trees),
    TrustRecordsRepositoryFake([
      TrustRecordRoot.make({ repo, tree: "aaaa", at: "2026-10-01T00:00:00.000Z" }),
    ]),
  );

const check = (path: string) => checkTrustHandler({ repo, path });

describe("checkTrustHandler", () => {
  effect("is trusted while the tree on the base branch is the one trusted", () =>
    Effect.gen(function* () {
      const trusted = yield* check("/src/trusted");
      const changed = yield* check("/src/changed");

      expect([trusted.tree, trusted.trusted]).toEqual([Option.some("aaaa"), true]);
      expect([changed.tree, changed.trusted]).toEqual([Option.some("bbbb"), false]);
    }).pipe(Effect.provide(checking({ "/src/trusted": "aaaa", "/src/changed": "bbbb" }))),
  );

  effect("has no tree, and isn't trusted, without a .chernabog/ on the base branch", () =>
    Effect.gen(function* () {
      const found = yield* check("/src/empty");

      expect([found.tree, found.trusted]).toEqual([Option.none(), false]);
    }).pipe(Effect.provide(checking({}))),
  );
});
