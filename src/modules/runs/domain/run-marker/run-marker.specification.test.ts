import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { Criteria, Spec } from "../../../../kernel/specification.ts";
import { type MarkerStatus, RunMarkerRoot } from "./run-marker.root.ts";
import { RunMarkerSpecifications } from "./run-marker.specification.ts";

const marker = (runId: string, name: string, status: MarkerStatus) =>
  RunMarkerRoot.make({
    runId: RunId.make(runId),
    name,
    args: {},
    keepOn: [],
    status,
    heldAt: "2026-10-20T00:00:00Z",
    attempts: 0,
    lastError: Option.none(),
    nextAttemptAt: Option.none(),
    settledAt: Option.none(),
  });

const markers = [
  marker("a", "claim", "held"),
  marker("a", "label", "released"),
  marker("b", "claim", "held"),
];

describe("RunMarkerSpecifications", () => {
  test("forRun and inStatus each narrow, and compose into one run's held markers", () => {
    expect(markers.filter(RunMarkerSpecifications.all)).toEqual(markers);
    expect(markers.filter(RunMarkerSpecifications.forRun(RunId.make("a")))).toEqual(
      markers.slice(0, 2),
    );
    expect(markers.filter(RunMarkerSpecifications.inStatus("held"))).toEqual([
      markers[0],
      markers[2],
    ]);
    expect(
      markers.filter(
        Spec.and(
          RunMarkerSpecifications.forRun(RunId.make("a")),
          RunMarkerSpecifications.inStatus("held"),
        ),
      ),
    ).toEqual([markers[0]]);
    expect(RunMarkerSpecifications.inStatus("held").criteria).toEqual(
      Criteria.Eq({ field: "status", value: "held" }),
    );
  });
});
