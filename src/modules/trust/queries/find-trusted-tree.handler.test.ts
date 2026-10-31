import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { TrustRecordRoot } from "../domain/trust-record/trust-record.root.ts";
import { TrustRecordsRepositoryFake } from "../infrastructure/repositories/trust-records.repository-fake.ts";
import { findTrustedTreeHandler } from "./find-trusted-tree.handler.ts";

const demo = RepoSlug.make("dataquail/demo");

describe("findTrustedTreeHandler", () => {
  effect("is the tree trusted, and none for a repo never trusted", () =>
    Effect.gen(function* () {
      expect((yield* findTrustedTreeHandler({ repo: demo })).tree).toEqual(Option.some("aaaa"));
      expect(
        (yield* findTrustedTreeHandler({ repo: RepoSlug.make("dataquail/other") })).tree,
      ).toEqual(Option.none());
    }).pipe(
      Effect.provide(
        TrustRecordsRepositoryFake([
          TrustRecordRoot.make({ repo: demo, tree: "aaaa", at: "2026-10-01T00:00:00.000Z" }),
        ]),
      ),
    ),
  );
});
