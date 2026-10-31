import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../test/sqlite.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunMarkersRepository } from "../domain/ports/repositories/run-markers.repository.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { RunRoot, type RunStatus } from "../domain/run/run.root.ts";
import { RunMarkerRootOps } from "../domain/run-marker/run-marker.root-ops.ts";
import { RunMarkersRepositoryLive } from "../infrastructure/repositories/run-markers.repository-live.ts";
import { RunsRepositoryLive } from "../infrastructure/repositories/runs.repository-live.ts";
import { listUnreleasedMarkersHandler } from "./list-unreleased-markers.handler.ts";

const AT = "2026-10-20T00:00:00.000Z";

const run = (id: string, status: RunStatus) =>
  RunRoot.make({
    id: RunId.make(id),
    coreVersion: "0.7.0",
    repo: "demo",
    persona: Option.none(),
    flow: "implement",
    itemKey: "issue-12",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    item: Option.none(),
    executionId: Option.none(),
    status,
    currentStep: Option.none(),
    summary: Option.none(),
    startedAt: AT,
    finishedAt: Option.none(),
  });

const marker = (runId: string, name: string) =>
  RunMarkerRootOps.hold({ runId: RunId.make(runId), name, args: {}, keepOn: [] }, AT);

describe("listUnreleasedMarkersHandler", () => {
  effect(
    "lists what ended runs still hold, and what's unreleasable, not what runs in flight hold",
    () =>
      Effect.gen(function* () {
        const runs = yield* RunsRepository;
        yield* runs.save(run("ended", "failed"));
        yield* runs.save(run("going", "running"));
        const markers = yield* RunMarkersRepository;
        yield* markers.save(marker("ended", "pending"));
        yield* markers.save(RunMarkerRootOps.released(marker("ended", "released"), AT));
        yield* markers.save(RunMarkerRootOps.kept(marker("ended", "kept"), AT));
        yield* markers.save(
          RunMarkerRootOps.unreleasable(marker("ended", "orphaned"), "no definition", AT),
        );
        yield* markers.save(marker("going", "in-flight"));

        expect(
          (yield* listUnreleasedMarkersHandler()).markers.map((found) => [found.runId, found.name]),
        ).toEqual([
          ["ended", "pending"],
          ["ended", "orphaned"],
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(RunsRepositoryLive, RunMarkersRepositoryLive).pipe(
            Layer.provide(sqliteAfter(Effect.void)),
          ),
        ),
      ),
  );
});
