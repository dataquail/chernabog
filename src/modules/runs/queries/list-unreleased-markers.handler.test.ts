import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot, type RunStatus } from "../domain/run/run.root.ts";
import { RunMarkerRootOps } from "../domain/run-marker/run-marker.root-ops.ts";
import { RunMarkersRepositoryFake } from "../infrastructure/repositories/run-markers.repository-fake.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
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
        expect(
          (yield* listUnreleasedMarkersHandler()).markers.map((found) => [found.runId, found.name]),
        ).toEqual([
          ["ended", "pending"],
          ["ended", "orphaned"],
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RunsRepositoryFake([run("ended", "failed"), run("going", "running")]),
            RunMarkersRepositoryFake([
              marker("ended", "pending"),
              RunMarkerRootOps.released(marker("ended", "released"), AT),
              RunMarkerRootOps.kept(marker("ended", "kept"), AT),
              RunMarkerRootOps.unreleasable(marker("ended", "orphaned"), "no definition", AT),
              marker("going", "in-flight"),
            ]),
          ),
        ),
      ),
  );
});
