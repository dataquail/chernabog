import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effectAtHome } from "../../../../test/effect-test.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { TrustRecordsRepository } from "../domain/ports/repositories/trust-records.repository.ts";
import { TrustRecordRoot } from "../domain/trust-record/trust-record.root.ts";
import { TrustRecordsRepositoryLive } from "../infrastructure/repositories/trust-records.repository-live.ts";
import { findTrustedTreeHandler } from "./find-trusted-tree.handler.ts";

const demo = RepoSlug.make("dataquail/demo");

describe("findTrustedTreeHandler", () => {
  effectAtHome("is the tree trusted, and none for a repo never trusted", () =>
    Effect.gen(function* () {
      yield* (yield* TrustRecordsRepository).save(
        TrustRecordRoot.make({ repo: demo, tree: "aaaa", at: "2026-10-01T00:00:00.000Z" }),
      );

      expect((yield* findTrustedTreeHandler({ repo: demo })).tree).toEqual(Option.some("aaaa"));
      expect(
        (yield* findTrustedTreeHandler({ repo: RepoSlug.make("dataquail/other") })).tree,
      ).toEqual(Option.none());
    }).pipe(Effect.provide(TrustRecordsRepositoryLive)),
  );
});
