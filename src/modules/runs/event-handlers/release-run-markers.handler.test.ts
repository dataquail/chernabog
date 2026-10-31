import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunEvents } from "../domain/run/run.events.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { type RunStatus } from "../domain/run/run-status.value-object.ts";
import { type RunMarkerRoot } from "../domain/run-marker/run-marker.root.ts";
import { RunMarkerRootOps } from "../domain/run-marker/run-marker.root-ops.ts";
import { type FakeFlow, FlowsClientFake } from "../infrastructure/clients/flows.client-fake.ts";
import { RunMarkersRepositoryFake } from "../infrastructure/repositories/run-markers.repository-fake.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { listUnreleasedMarkersHandler } from "../queries/list-unreleased-markers.handler.ts";
import { releaseRunMarkersHandler } from "./release-run-markers.handler.ts";

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
    finishedAt: Option.liftPredicate(AT, () => status !== "running"),
  });

// What the run's ending said on the bus.
const finished = (ended: RunRoot) => Option.getOrThrow(RunEvents.finished(ended));

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
    PassThroughUnitOfWork,
  );

const released = (releases: ReadonlyArray<{ runId: string; name: string }>) =>
  releases.map((release) => [release.runId, release.name]);

describe("releaseRunMarkersHandler", () => {
  effect("releases the ended run's markers at once, newest first, and no other run's", () => {
    const releases: Array<{ runId: string; name: string; args: Schema.Json }> = [];
    const ended = run("a", "failed");

    return Effect.gen(function* () {
      yield* releaseRunMarkersHandler(finished(ended));

      expect(released(releases)).toEqual([
        ["a", "second"],
        ["a", "first"],
      ]);
      expect((yield* listUnreleasedMarkersHandler()).markers.map((left) => left.runId)).toEqual([
        RunId.make("c"),
      ]);
    }).pipe(
      Effect.provide(
        runtime(
          [ended, run("b", "running"), run("c", "failed")],
          [marker("a", "first"), marker("b", "first"), marker("a", "second"), marker("c", "first")],
          { items: [], markers: ["first", "second"], releases },
        ),
      ),
    );
  });

  effect("releases nothing a second time for a repeat of the event", () => {
    const releases: Array<{ runId: string; name: string; args: Schema.Json }> = [];
    const ended = run("a", "cancelled");

    return Effect.gen(function* () {
      yield* releaseRunMarkersHandler(finished(ended));
      yield* releaseRunMarkersHandler(finished(ended));

      expect(released(releases)).toEqual([["a", "first"]]);
    }).pipe(
      Effect.provide(
        runtime([ended], [marker("a", "first")], { items: [], markers: ["first"], releases }),
      ),
    );
  });

  effect("keeps a marker on an ending its keepOn names", () => {
    const releases: Array<{ runId: string; name: string; args: Schema.Json }> = [];
    const ended = run("a", "needs-human");

    return Effect.gen(function* () {
      yield* releaseRunMarkersHandler(finished(ended));

      expect(releases).toEqual([]);
      expect(
        (yield* listUnreleasedMarkersHandler()).markers.map((left) => [left.name, left.status]),
      ).toEqual([]);
    }).pipe(
      Effect.provide(
        runtime([ended], [marker("a", "needs-person", ["needs-human"])], {
          items: [],
          markers: ["needs-person"],
          releases,
        }),
      ),
    );
  });

  effect("leaves a release that fails held, backing off, for the sweep to try again", () => {
    const releases: Array<{ runId: string; name: string; args: Schema.Json }> = [];
    const ended = run("a", "done");

    return Effect.gen(function* () {
      yield* releaseRunMarkersHandler(finished(ended));

      expect(
        (yield* listUnreleasedMarkersHandler()).markers.map((left) => [
          left.name,
          left.attempts,
          left.lastError,
        ]),
      ).toEqual([["first", 1, Option.some("GitHub is down")]]);
    }).pipe(
      Effect.provide(
        runtime([ended], [marker("a", "first")], {
          items: [],
          markers: ["first"],
          releases,
          releaseFails: ["GitHub is down"],
        }),
      ),
    );
  });
});
