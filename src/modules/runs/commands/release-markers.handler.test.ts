import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { type RunStatus } from "../domain/run/run-status.value-object.ts";
import { type RunMarkerRoot } from "../domain/run-marker/run-marker.root.ts";
import { RunMarkerRootOps } from "../domain/run-marker/run-marker.root-ops.ts";
import { type FakeFlow, FlowsClientFake } from "../infrastructure/clients/flows.client-fake.ts";
import { RunMarkersRepositoryFake } from "../infrastructure/repositories/run-markers.repository-fake.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { listUnreleasedMarkersHandler } from "../queries/list-unreleased-markers.handler.ts";
import { releaseMarkersHandler } from "./release-markers.handler.ts";

const AT = "2026-10-20T00:00:00.000Z";

const run = (id: string, status: RunStatus) =>
  RunRoot.make({
    id: RunId.make(id),
    coreVersion: "0.7.0",
    repo: "demo",
    persona: Option.some("bob"),
    flow: "implement",
    itemKey: "issue-12",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    item: Option.some({ key: "issue-12", data: { issue: 12 } }),
    executionId: Option.some(`execution-${id}`),
    status,
    currentStep: Option.none(),
    summary: Option.none(),
    startedAt: AT,
    finishedAt: Option.none(),
  });

const marker = (runId: string, name: string, keepOn: ReadonlyArray<string> = []) =>
  RunMarkerRootOps.hold({ runId: RunId.make(runId), name, args: { key: name }, keepOn }, AT);

const runtime = (
  runs: ReadonlyArray<RunRoot>,
  markers: ReadonlyArray<RunMarkerRoot>,
  flow: FakeFlow,
) =>
  Layer.mergeAll(
    RunsRepositoryFake(runs),
    RunMarkersRepositoryFake(markers),
    FlowsClientFake({ "demo/implement": flow }),
  );

const names = (views: ReadonlyArray<{ readonly name: string }>) => views.map((view) => view.name);

describe("releaseMarkersHandler", () => {
  effect("releases an ended run's markers newest first, and leaves a run in flight's", () => {
    const releases: Array<{ runId: string; name: string; args: Schema.Json }> = [];

    return Effect.gen(function* () {
      const done = yield* releaseMarkersHandler();

      expect(names(done.released)).toEqual(["second", "first"]);
      expect(releases.map((release) => [release.runId, release.name, release.args])).toEqual([
        ["a", "second", { key: "second" }],
        ["a", "first", { key: "first" }],
      ]);

      // Released once: a second pass has nothing to do.
      expect(names((yield* releaseMarkersHandler()).released)).toEqual([]);
      expect((yield* listUnreleasedMarkersHandler()).markers).toEqual([]);
    }).pipe(
      Effect.provide([
        runtime(
          [run("a", "failed"), run("b", "running")],
          [marker("a", "first"), marker("b", "first"), marker("a", "second")],
          { items: [], markers: ["first", "second"], releases },
        ),
        PassThroughUnitOfWork,
      ]),
    );
  });

  effect("keeps a marker on an ending its keepOn names, and releases it on any other", () =>
    Effect.gen(function* () {
      const done = yield* releaseMarkersHandler();

      expect(names(done.kept)).toEqual(["needs-person"]);
      expect(done.kept[0]?.runId).toBe(RunId.make("a"));
      expect(done.released.map((view) => view.runId)).toEqual([RunId.make("b")]);
    }).pipe(
      Effect.provide([
        runtime(
          [run("a", "needs-human"), run("b", "cancelled")],
          [
            marker("a", "needs-person", ["needs-human"]),
            marker("b", "needs-person", ["needs-human"]),
          ],
          { items: [], markers: ["needs-person"], releases: [] },
        ),
        PassThroughUnitOfWork,
      ]),
    ),
  );

  effect("keeps a release that fails held, says why, and tries it again once due", () => {
    const fails = ["GitHub is down"];
    const releases: Array<{ runId: string; name: string; args: Schema.Json }> = [];

    return Effect.gen(function* () {
      const first = yield* releaseMarkersHandler();
      expect(first.failed.map((view) => [view.name, view.attempts, view.lastError])).toEqual([
        ["first", 1, Option.some("GitHub is down")],
      ]);

      // Status shows it until it succeeds.
      expect(names((yield* listUnreleasedMarkersHandler()).markers)).toEqual(["first"]);

      // Not due yet: nothing is tried.
      fails.length = 0;
      expect(names((yield* releaseMarkersHandler()).released)).toEqual([]);
      expect(releases).toEqual([]);
    }).pipe(
      Effect.provide([
        runtime([run("a", "failed")], [marker("a", "first")], {
          items: [],
          markers: ["first"],
          releases,
          releaseFails: fails,
        }),
        PassThroughUnitOfWork,
      ]),
    );
  });

  effect("tries a release that failed again once its backoff has passed", () =>
    Effect.gen(function* () {
      const done = yield* releaseMarkersHandler();

      expect(names(done.released)).toEqual(["first"]);
    }).pipe(
      Effect.provide([
        runtime(
          [run("a", "failed")],
          [
            // Failed long ago, so its retry is due.
            RunMarkerRootOps.failed(
              marker("a", "first"),
              "GitHub is down",
              DateTime.makeUnsafe(AT),
            ),
          ],
          { items: [], markers: ["first"], releases: [] },
        ),
        PassThroughUnitOfWork,
      ]),
    ),
  );

  effect(
    "marks a marker the flow no longer defines unreleasable, with its arguments, for a person",
    () =>
      Effect.gen(function* () {
        const done = yield* releaseMarkersHandler();

        expect(done.unreleasable.map((view) => [view.name, view.args, view.lastError])).toEqual([
          ["gone", { key: "gone" }, Option.some("implement no longer defines marker gone")],
        ]);
        expect(names((yield* releaseMarkersHandler()).unreleasable)).toEqual([]);
        expect(
          (yield* listUnreleasedMarkersHandler()).markers.map((view) => [view.name, view.status]),
        ).toEqual([["gone", "unreleasable"]]);
      }).pipe(
        Effect.provide([
          runtime([run("a", "done")], [marker("a", "gone")], {
            items: [],
            markers: [],
            releases: [],
          }),
          PassThroughUnitOfWork,
        ]),
      ),
  );

  effect(
    "leaves a run that just ended to its ending's release, and sweeps it once the grace is up",
    () => {
      const releases: Array<{ runId: string; name: string; args: Schema.Json }> = [];
      const now = DateTime.nowUnsafe();

      const justEnded = DateTime.formatIso(now);

      const longAgo = DateTime.formatIso(
        DateTime.subtractDuration(now, RunMarkerRootOps.SWEEP_GRACE),
      );

      return Effect.gen(function* () {
        const done = yield* releaseMarkersHandler();

        expect(done.released.map((view) => view.runId)).toEqual([RunId.make("b")]);
        expect(releases.map((release) => release.runId)).toEqual(["b"]);
      }).pipe(
        Effect.provide([
          runtime(
            [
              RunRoot.make({ ...run("a", "done"), finishedAt: Option.some(justEnded) }),
              RunRoot.make({ ...run("b", "done"), finishedAt: Option.some(longAgo) }),
            ],
            [marker("a", "first"), marker("b", "first")],
            { items: [], markers: ["first"], releases },
          ),
          PassThroughUnitOfWork,
        ]),
      );
    },
  );
});
