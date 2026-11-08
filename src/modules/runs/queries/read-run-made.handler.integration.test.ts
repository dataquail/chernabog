import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { effect } from "../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../test/sqlite.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunCreatedIssueEntity } from "../domain/run/run-created-issue.entity.ts";
import { RunCreatedIssuesRepository } from "../domain/run/run-created-issues.repository.ts";
import { RunMarkerRootOps } from "../domain/run-marker/run-marker.root-ops.ts";
import { RunMarkersRepository } from "../domain/run-marker/run-markers.repository.ts";
import { RunCreatedIssuesRepositoryLive } from "../infrastructure/repositories/run-created-issues.repository-live.ts";
import { RunMarkersRepositoryLive } from "../infrastructure/repositories/run-markers.repository-live.ts";
import { readRunMadeHandler } from "./read-run-made.handler.ts";

const AT = "2026-11-07T00:00:00.000Z";
const a = RunId.make("a");

const claim = (runId: RunId, item: string, named: string) =>
  RunMarkerRootOps.hold(
    { runId, name: "chernabog/claim-ref", args: { item, runId: named }, keepOn: [] },
    AT,
  );

const stores = Layer.mergeAll(RunCreatedIssuesRepositoryLive, RunMarkersRepositoryLive).pipe(
  Layer.provideMerge(sqliteAfter(Effect.void)),
);

describe("readRunMadeHandler", () => {
  effect("reads the issues a run created and every claim ref it took, from its journal", () =>
    Effect.gen(function* () {
      const created = yield* RunCreatedIssuesRepository;
      yield* created.insertOne(RunCreatedIssueEntity.make({ runId: a, issue: 13, createdAt: AT }));
      yield* created.insertOne(RunCreatedIssueEntity.make({ runId: a, issue: 14, createdAt: AT }));

      yield* created.insertOne(
        RunCreatedIssueEntity.make({ runId: RunId.make("b"), issue: 20, createdAt: AT }),
      );

      const markers = yield* RunMarkersRepository;

      for (const held of [
        // A parked epic's claim, still held when the rehearsal stopped following it.
        claim(a, "epic-12", "a"),
        // A claim the run's ending already let go of.
        RunMarkerRootOps.released(claim(a, "issue-13", "a"), AT),
        // Not claims, or not this run's.
        RunMarkerRootOps.hold(
          { runId: a, name: "chernabog/label", args: { number: 12 }, keepOn: [] },
          AT,
        ),
        claim(RunId.make("b"), "issue-20", "b"),
      ]) {
        yield* markers.upsertOne(held);
      }

      const made = yield* readRunMadeHandler({ runId: a });

      expect(made.createdIssues).toEqual([13, 14]);
      expect(made.claims).toEqual([
        { item: "epic-12", runId: "a" },
        { item: "issue-13", runId: "a" },
      ]);

      const none = yield* readRunMadeHandler({ runId: RunId.make("c") });

      expect([none.createdIssues, none.claims]).toEqual([[], []]);
    }).pipe(Effect.provide(stores)),
  );
});
