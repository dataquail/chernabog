import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../../test/effect-test.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { ReloadsRepositoryFake } from "../infrastructure/repositories/reloads.repository-fake.ts";
import { claimReloadHandler } from "./claim-reload.handler.ts";

const demo = RepoSlug.make("dataquail/demo");
const other = RepoSlug.make("dataquail/other");

const first = (repo: RepoSlug, tree: string) =>
  Effect.map(claimReloadHandler({ repo, tree }), (claim) => claim.first);

describe("claimReloadHandler", () => {
  effect("a tree restarts the daemon once, per repo, and again after another tree did", () =>
    Effect.gen(function* () {
      expect(yield* first(demo, "a")).toBe(true);
      expect(yield* first(demo, "a")).toBe(false);
      expect(yield* first(other, "a")).toBe(true);
      expect(yield* first(demo, "b")).toBe(true);
      expect(yield* first(demo, "a")).toBe(true);
    }).pipe(Effect.provide([ReloadsRepositoryFake([]), PassThroughUnitOfWork])),
  );
});
