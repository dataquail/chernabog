import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { DispatchedEvents, RecordedEvents } from "../../../../test/events.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { TrustRecordsRepository } from "../domain/ports/repositories/trust-records.repository.ts";
import { RepoTrusted } from "../domain/trust-record/trust-record.events.ts";
import { TrustRecordRoot } from "../domain/trust-record/trust-record.root.ts";
import { ConfigTreeClientFake } from "../infrastructure/clients/config-tree.client-fake.ts";
import { TrustRecordsRepositoryFake } from "../infrastructure/repositories/trust-records.repository-fake.ts";
import { trustRepoHandler } from "./trust-repo.handler.ts";

const repo = RepoSlug.make("dataquail/demo");
const target = { repo, path: "/src/demo" };

const trusting = (tree: string, records: ReadonlyArray<TrustRecordRoot>) =>
  Layer.mergeAll(
    RecordedEvents,
    ConfigTreeClientFake({ "/src/demo": tree }),
    TrustRecordsRepositoryFake(records),
  );

const record = (tree: string) =>
  TrustRecordRoot.make({ repo, tree, at: "2026-10-01T00:00:00.000Z" });

describe("trustRepoHandler", () => {
  effect("a first trust lists what .chernabog/ holds and records the tree", () =>
    Effect.gen(function* () {
      const outcome = yield* trustRepoHandler(target);

      expect([outcome.tree, outcome.previous, outcome.changes, outcome.trusted]).toEqual([
        "aaaa",
        Option.none(),
        Option.some("first trust of aaaa"),
        true,
      ]);
      expect(
        Option.map(yield* (yield* TrustRecordsRepository).findOne(repo), (found) => found.tree),
      ).toEqual(Option.some("aaaa"));
    }).pipe(Effect.provide(trusting("aaaa", []))),
  );

  effect("a changed tree shows what changed since the one trusted before, then trusts it", () =>
    Effect.gen(function* () {
      const outcome = yield* trustRepoHandler(target);

      expect([outcome.previous, outcome.changes, outcome.trusted]).toEqual([
        Option.some("aaaa"),
        Option.some("aaaa..bbbb"),
        true,
      ]);
      const saved = yield* (yield* TrustRecordsRepository).findOne(repo);

      expect(Option.map(saved, (found) => found.tree)).toEqual(Option.some("bbbb"));
      expect(yield* DispatchedEvents).toEqual(
        Option.toArray(
          Option.map(saved, (found) =>
            RepoTrusted.make({
              eventId: `dataquail/demo:trusted:bbbb:${found.at}`,
              repo,
              tree: "bbbb",
              previous: Option.some("aaaa"),
              trustedAt: found.at,
            }),
          ),
        ),
      );
    }).pipe(Effect.provide(trusting("bbbb", [record("aaaa")]))),
  );

  effect("the tree already trusted changes nothing", () =>
    Effect.gen(function* () {
      const outcome = yield* trustRepoHandler(target);

      expect([outcome.changes, outcome.trusted]).toEqual([Option.none(), false]);
      expect(yield* (yield* TrustRecordsRepository).findOne(repo)).toEqual(
        Option.some(record("aaaa")),
      );
      expect(yield* DispatchedEvents).toEqual([]);
    }).pipe(Effect.provide(trusting("aaaa", [record("aaaa")]))),
  );

  effect("fails, trusting nothing, when the default branch has no .chernabog/", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(trustRepoHandler({ ...target, path: "/src/elsewhere" }));

      expect(refused.message).toBe(
        "/src/elsewhere: no .chernabog/ on the default branch; run chernabog init and merge it first",
      );
      expect(yield* (yield* TrustRecordsRepository).findOne(repo)).toEqual(Option.none());
      expect(yield* DispatchedEvents).toEqual([]);
    }).pipe(Effect.provide(trusting("aaaa", []))),
  );
});
