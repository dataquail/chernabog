import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../test/effect-test.ts";
import { dispatchEvents, TestEventBus } from "../../../test/events.ts";
import { RunId } from "../../kernel/run-id.id.ts";
import {
  MarkerReleases,
  RunMarkersReleased,
  RunMarkerView,
} from "../../modules/runs/runs.platform.ts";
import { subscribeMarkerReleases } from "./marker-releases.event-adapter.ts";

const view = (name: string, status: RunMarkerView["status"], attempts = 0) =>
  RunMarkerView.make({
    runId: RunId.make("a"),
    name,
    args: {},
    keepOn: [],
    status,
    heldAt: "2026-10-31T00:00:00.000Z",
    attempts,
    lastError: Option.none(),
    nextAttemptAt: Option.none(),
  });

const releases = MarkerReleases.make({
  released: [view("first", "released")],
  kept: [],
  failed: [view("second", "held", 1)],
  unreleasable: [view("gone", "unreleasable")],
});

describe("subscribeMarkerReleases", () => {
  effect("tells the daemon what a run's ending released", () =>
    Effect.gen(function* () {
      const told: Array<MarkerReleases> = [];

      yield* subscribeMarkerReleases((said) => Effect.sync(() => told.push(said)));

      const event = RunMarkersReleased.make({
        eventId: "a:markers",
        runId: RunId.make("a"),
        releases,
      });

      // A bus with no unit of work runs after-commit handlers as it dispatches.
      yield* dispatchEvents([event]);

      expect(told).toEqual([releases]);
    }).pipe(Effect.provide(TestEventBus)),
  );
});
