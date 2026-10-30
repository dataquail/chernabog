// Markers through the real engine and the daemon's release: a flow that puts
// something on its own system and holds a marker for it sees it taken off
// however the run ends; one held to stay for a person stays; a release that
// fails is retried and shown until it succeeds; and an implement run that
// fails partway leaves no auto:in-progress and no assignment.

import {
  activity,
  DEFAULT_LABELS,
  defineFlow,
  type Flow,
  Markers,
  NeedsHuman,
  Run,
  RunLog,
  StepFailed,
} from "@chernabog/sdk";
import type { BunServices } from "@effect/platform-bun";
import { describe, expect } from "bun:test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import implement from "../packages/recipes/flows/implement.ts";
import { IMPLICIT } from "../src/kernel/persona.value-object.ts";
import { cancelRunHandler } from "../src/modules/runs/commands/cancel-run.handler.ts";
import {
  type FlowHandle,
  flowHandle,
  flowLayer,
  forEveryPersona,
} from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { listRunMarkersHandler } from "../src/modules/runs/queries/list-run-markers.handler.ts";
import { listUnreleasedMarkersHandler } from "../src/modules/runs/queries/list-unreleased-markers.handler.ts";
import { RunLogsLayer, RuntimeLayer, StateAt } from "../src/modules/runs/runs.layer.ts";
import { CancelTarget } from "../src/modules/runs/use-cases/cancel-run.result.ts";
import { releaseMarkersUseCase } from "../src/modules/runs/use-cases/release-markers.use-case.ts";
import { Home, homePaths } from "../src/platform/home.ts";
import { effect } from "./effect-test.ts";
import {
  type EngineRun,
  type Fake,
  ISSUE,
  item,
  makeFake,
  onFake,
  pollRun,
  repo,
  runToEnd,
  startRun,
} from "./sdk-fakes.ts";

const POLLS = { schedule: Schedule.spaced("25 millis"), times: 200 };

const quietLog = Layer.succeed(
  RunLog,
  RunLog.of({ log: () => Effect.void, step: () => Effect.void, stepDone: () => Effect.void }),
);

// A system of a flow's own, outside chernabog: the tickets in progress, and
// whether taking one off fails, as an outage would.
const makeTracker = () => ({
  inProgress: new Set<string>(),
  releases: 0,
  down: false,
});

type Tracker = ReturnType<typeof makeTracker>;

// A flow that marks a ticket in progress on its tracker, holding a marker for
// it, then ends as `end` says, or waits until cancelled.
const trackerFlow = (
  tracker: Tracker,
  end: "done" | "fail" | "needs-human" | "hang",
  options: Markers.HoldOptions = {},
) => {
  const inProgress = Markers.define(
    "tracker-in-progress",
    Schema.Struct({ key: Schema.String }),
    (args) =>
      Effect.suspend(() => {
        if (tracker.down) {
          return Effect.fail(new StepFailed({ step: "tracker", message: "the tracker is down" }));
        }

        tracker.releases += 1;
        tracker.inProgress.delete(args.key);

        return Effect.void;
      }),
  );

  const flow: Flow = defineFlow({
    trigger: Effect.succeed([]),
    markers: [inProgress],
    workflow: () =>
      Effect.gen(function* () {
        yield* activity(
          "start",
          Effect.gen(function* () {
            yield* Markers.hold(inProgress, { key: "T-1" }, options);
            tracker.inProgress.add("T-1");
            // Held again, as a resumed run holding it a second time would.
            yield* Markers.hold(inProgress, { key: "T-1" }, options);
          }),
        );

        if (end === "fail") {
          return yield* new StepFailed({ step: "work", message: "it broke" });
        }

        if (end === "needs-human") {
          return yield* new NeedsHuman({ reason: "a person should look" });
        }

        if (end === "hang") {
          yield* activity("work", Effect.never);
        }

        return "done";
      }),
  });

  return flow;
};

// The engine over one flow as the daemon builds it, with the fake's services
// for the flow's releases.
const withEngine = <A, E, R>(handle: FlowHandle, fake: Fake, body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-markers-" });
    const platform = yield* Effect.context<BunServices.BunServices>();
    const services = yield* Layer.build(Layer.mergeAll(fake.services, quietLog));
    const context = Context.merge(platform, services);

    const engine = yield* Layer.build(
      RuntimeLayer({
        handles: [handle],
        services: () => Option.some(Effect.succeed(context)),
      }).pipe(
        Layer.merge(RunLogsLayer),
        Layer.provideMerge(flowLayer(handle, forEveryPersona(services))),
        Layer.provideMerge(StateAt(homePaths(home).state)),
        Layer.provideMerge(Home.at(home, home)),
      ),
    );

    return yield* Effect.provideContext(body, Context.merge(platform, engine));
  });

// Runs a release as the daemon does, outside the run: as the fake's persona, for `runId`.
const asRun = <A, E>(
  fake: Fake,
  runId: string,
  release: Effect.Effect<A, E, Markers.ReleaseServices>,
) =>
  onFake(
    fake,
    Effect.provide(
      release,
      Layer.mergeAll(
        quietLog,
        Layer.succeed(
          Run,
          Run.of({
            flow: "implement",
            runId,
            executionId: "",
            item: item(`issue-${ISSUE}`),
          }),
        ),
      ),
    ),
  );

const ended = (run: EngineRun) =>
  pollRun(run).pipe(Effect.repeat({ ...POLLS, until: (polled) => polled.status !== "running" }));

// Runs the flow to its end, and releases what it held, as the daemon does.
const runAndRelease = (handle: FlowHandle) =>
  Effect.gen(function* () {
    const started = Option.getOrThrow((yield* startRun(handle, IMPLICIT, item("T-1"))).run);
    const finished = yield* ended(started);
    const releases = yield* releaseMarkersUseCase();

    return { finished, releases };
  });

describe("a flow's own marker", () => {
  for (const [end, status] of [
    ["done", "done"],
    ["fail", "failed"],
  ] as const) {
    effect(`is taken off when the run ends ${status}, once, though held twice`, () =>
      Effect.gen(function* () {
        const tracker = makeTracker();
        const handle = flowHandle(repo, "tracked", trackerFlow(tracker, end));

        const value = yield* withEngine(handle, makeFake("approve"), runAndRelease(handle));

        expect(value.finished.status).toBe(status);
        expect(value.releases.released.map((marker) => marker.name)).toEqual([
          "tracker-in-progress",
        ]);
        expect([...tracker.inProgress]).toEqual([]);
        expect(tracker.releases).toBe(1);
      }),
    );
  }

  effect("is taken off when the run is cancelled mid-step", () =>
    Effect.gen(function* () {
      const tracker = makeTracker();
      const handle = flowHandle(repo, "tracked", trackerFlow(tracker, "hang"));

      const value = yield* withEngine(
        handle,
        makeFake("approve"),
        Effect.gen(function* () {
          const started = Option.getOrThrow((yield* startRun(handle, IMPLICIT, item("T-1"))).run);

          yield* pollRun(started).pipe(
            Effect.repeat({ ...POLLS, until: (run) => Option.contains(run.currentStep, "work") }),
          );

          // In flight, it keeps what it holds.
          const whileRunning = yield* releaseMarkersUseCase();

          const held = (yield* listRunMarkersHandler({ runId: started.id, name: Option.none() }))
            .markers;

          yield* cancelRunHandler({
            target: CancelTarget.cases.ById.make({ asked: started.id }),
            by: "alice",
            closeSessions: false,
            endAs: Option.none(),
          });

          const releases = yield* releaseMarkersUseCase();

          return { whileRunning, held, releases, polled: yield* pollRun(started) };
        }),
      );

      expect(value.whileRunning.released).toEqual([]);
      expect(value.held.map((marker) => [marker.name, marker.args])).toEqual([
        ["tracker-in-progress", { key: "T-1" }],
      ]);
      expect(value.polled.status).toBe("cancelled");
      expect(value.releases.released.map((marker) => marker.name)).toEqual(["tracker-in-progress"]);
      expect([...tracker.inProgress]).toEqual([]);
    }),
  );

  effect("held to stay on needs-human, stays when the run hands off to a person", () =>
    Effect.gen(function* () {
      const tracker = makeTracker();

      const handle = flowHandle(
        repo,
        "tracked",
        trackerFlow(tracker, "needs-human", { keepOn: ["needs-human"] }),
      );

      const value = yield* withEngine(handle, makeFake("approve"), runAndRelease(handle));

      expect(value.finished.status).toBe("needs-human");
      expect(value.releases.kept.map((marker) => marker.name)).toEqual(["tracker-in-progress"]);
      expect([...tracker.inProgress]).toEqual(["T-1"]);
    }),
  );

  effect("whose release fails is retried, and shown, until it succeeds", () =>
    Effect.gen(function* () {
      const tracker = makeTracker();
      tracker.down = true;
      const handle = flowHandle(repo, "tracked", trackerFlow(tracker, "done"));

      const value = yield* withEngine(
        handle,
        makeFake("approve"),
        Effect.gen(function* () {
          const first = yield* runAndRelease(handle);
          const shown = yield* listUnreleasedMarkersHandler();

          return { first, shown };
        }),
      );

      expect(value.first.releases.failed.map((marker) => [marker.name, marker.attempts])).toEqual([
        ["tracker-in-progress", 1],
      ]);
      expect(Option.getOrThrow(value.first.releases.failed[0].lastError)).toContain(
        "the tracker is down",
      );
      expect(value.shown.markers.map((marker) => marker.status)).toEqual(["held"]);
      expect([...tracker.inProgress]).toEqual(["T-1"]);
    }),
  );

  effect("that the flow doesn't list can't be held, and the run says why", () =>
    Effect.gen(function* () {
      const stray = Markers.define("stray", Schema.Struct({}), () => Effect.void);

      const handle = flowHandle(
        repo,
        "stray",
        defineFlow({
          trigger: Effect.succeed([]),
          workflow: () => activity("start", Markers.hold(stray, {})),
        }),
      );

      const value = yield* withEngine(handle, makeFake("approve"), runAndRelease(handle));

      expect(value.finished.status).toBe("failed");
      expect(Option.getOrElse(value.finished.summary, () => "")).toContain(
        "marker stray isn't among the flow's markers",
      );
    }),
  );
});

describe("the SDK's markers", () => {
  effect("an implement run that fails partway leaves no auto:in-progress and no assignment", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve", { install: Option.some("exit 3") });
      fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
      const handle = flowHandle(repo, "implement", implement);

      const finished = yield* runToEnd(handle, fake, item(`issue-${ISSUE}`, { issue: ISSUE }));

      expect(finished.status).toBe("needs-human");
      expect(fake.labelsOf(ISSUE)).toEqual([DEFAULT_LABELS.needsHuman]);
      expect(fake.people.assigned).toEqual([]);

      // Each release is safe to run again, as one a crash interrupted does.
      for (const again of [
        Markers.label.releaseJson({ number: ISSUE, label: DEFAULT_LABELS.inProgress }),
        Markers.assignment.releaseJson({ number: ISSUE, login: fake.people.me }),
        Markers.claimBranch.releaseJson({ branch: `auto/issue-${ISSUE}` }),
      ]) {
        yield* asRun(fake, finished.id, again);
      }

      expect(fake.labelsOf(ISSUE)).toEqual([DEFAULT_LABELS.needsHuman]);
    }),
  );

  effect("a claim branch is compared with the base it was cut from, such as develop", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      const branch = `auto/issue-${ISSUE}`;

      yield* asRun(fake, "run-1", Markers.claimBranch.releaseJson({ branch, base: "develop" }));
      // One held before the claim recorded its base compares with the repo's.
      yield* asRun(fake, "run-1", Markers.claimBranch.releaseJson({ branch }));

      expect(fake.based.compared).toEqual(["develop", "main"]);
    }),
  );

  effect(
    "an implement run that's done keeps its assignment and lets the in-progress label go",
    () =>
      Effect.gen(function* () {
        const fake = makeFake("approve", { reviewers: ["zach"] });
        fake.setLabels(ISSUE, [DEFAULT_LABELS.eligible]);
        const handle = flowHandle(repo, "implement", implement);

        const finished = yield* runToEnd(handle, fake, item(`issue-${ISSUE}`, { issue: ISSUE }));

        expect(finished.status).toBe("done");
        expect(fake.labelsOf(ISSUE)).not.toContain(DEFAULT_LABELS.inProgress);
        expect(fake.people.assigned).toEqual([fake.people.me]);
      }),
  );
});
