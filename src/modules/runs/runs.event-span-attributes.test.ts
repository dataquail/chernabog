import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { RunId } from "../../kernel/run-id.id.ts";
import { RunEvents } from "./domain/run/run.events.ts";
import { RunMarkersReleased } from "./domain/run-marker/run-marker.events.ts";
import { MarkerReleases } from "./domain/run-marker/run-marker-view.value-object.ts";
import { runFlowsCommandGroup, runsCommandGroup } from "./runs.command-handlers.ts";
import {
  runEventSpanAttributes,
  runFlowsCommandSpanAttributes,
  runFlowsQuerySpanAttributes,
  runLogsQuerySpanAttributes,
  runsCommandSpanAttributes,
  runsQuerySpanAttributes,
} from "./runs.event-span-attributes.ts";
import { runFlowsQueryGroup, runLogsQueryGroup, runsQueryGroup } from "./runs.query-handlers.ts";

const runId = RunId.make("0b6f1c9e-run");
const flow = { repo: "acme/widgets", flow: "implement", persona: Option.some("alice") };

describe("the runs' span attributes", () => {
  test("each extractor is for a message its group carries", () => {
    const pairs = [
      [runsCommandSpanAttributes, runsCommandGroup.tags],
      [runFlowsCommandSpanAttributes, runFlowsCommandGroup.tags],
      [runsQuerySpanAttributes, runsQueryGroup.tags],
      [runFlowsQuerySpanAttributes, runFlowsQueryGroup.tags],
      [runLogsQuerySpanAttributes, runLogsQueryGroup.tags],
    ] as const;

    for (const [extractors, tags] of pairs) {
      const unknown = Object.keys(extractors).filter((tag) => !tags.includes(tag));

      expect(unknown).toEqual([]);
    }
  });

  test("a message about one run names the run", () => {
    expect(runsCommandSpanAttributes.EnterStepCommand({ runId })).toEqual({
      "run.id": runId,
    });
    expect(runFlowsCommandSpanAttributes.PollRunCommand({ runId })).toEqual({ "run.id": runId });
    expect(runsQuerySpanAttributes.FindRunQuery({ runId })).toEqual({ "run.id": runId });
  });

  test("a message about a flow names its repo and flow", () => {
    expect(runFlowsCommandSpanAttributes.PlanTickCommand({ flow })).toEqual({
      "run.repo": "acme/widgets",
      "run.flow": "implement",
    });
    expect(
      runsQuerySpanAttributes.FindActiveRunQuery({ repo: "acme/widgets", flow: "review" }),
    ).toEqual({ "run.repo": "acme/widgets", "run.flow": "review" });
  });

  test("starting a run names the run, its repo and its flow", () => {
    expect(
      runsCommandSpanAttributes.StartRunCommand({
        id: runId,
        repo: "acme/widgets",
        flow: "implement",
      }),
    ).toEqual({ "run.id": runId, "run.repo": "acme/widgets", "run.flow": "implement" });
  });

  test("a run's events name the run, and its repo and flow where they carry them", () => {
    const started = RunEvents.started({
      id: runId,
      repo: "acme/widgets",
      persona: Option.none(),
      flow: "implement",
      itemKey: "issue-7",
      startedAt: "2026-10-31T00:00:00.000Z",
    });

    expect(runEventSpanAttributes.RunStarted(started)).toEqual({
      "run.id": runId,
      "run.repo": "acme/widgets",
      "run.flow": "implement",
    });
    expect(
      runEventSpanAttributes.RunEnteredStep(
        RunEvents.enteredStep(runId, "ci", "2026-10-31T00:01:00.000Z"),
      ),
    ).toEqual({ "run.id": runId });
    expect(
      runEventSpanAttributes.RunMarkersReleased(
        RunMarkersReleased.make({
          eventId: `${runId}:markers`,
          runId,
          releases: MarkerReleases.make({ released: [], kept: [], failed: [], unreleasable: [] }),
        }),
      ),
    ).toEqual({ "run.id": runId });
  });
});
