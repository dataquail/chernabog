import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { LaneLayouts } from "./lane-layout.domain-service.ts";

describe("lanes laid out beside one another", () => {
  test("a lane that waited on nothing hangs off the origin, one that waited sits past what it waited on", () => {
    const layout = LaneLayouts.layOut(
      ["task-1", "task-2", "task-3"],
      [
        { lane: "task-2", needs: ["task-1"] },
        { lane: "task-3", needs: ["task-2", "task-1"] },
      ],
      Option.some("tasks"),
    );

    expect(layout.lanes).toEqual([
      { lane: "task-1", needs: [], column: 1 },
      { lane: "task-2", needs: ["task-1"], column: 2 },
      { lane: "task-3", needs: ["task-2", "task-1"], column: 3 },
    ]);
    expect(layout.edges).toEqual([
      { from: "tasks", to: "task-1" },
      { from: "task-1", to: "task-2" },
      { from: "task-2", to: "task-3" },
      { from: "task-1", to: "task-3" },
    ]);
    expect(LaneLayouts.columns(layout)).toEqual([["task-1"], ["task-2"], ["task-3"]]);
  });

  test("needs name only lanes there are, never the lane itself nor the origin", () => {
    const layout = LaneLayouts.layOut(
      ["", "task-1", "task-2"],
      [{ lane: "task-2", needs: ["task-2", "", "task-9", "task-1", "task-1"] }],
      Option.some(""),
    );

    expect(layout.lanes).toEqual([
      { lane: "task-1", needs: [], column: 1 },
      { lane: "task-2", needs: ["task-1"], column: 2 },
    ]);
  });

  test("with no origin, a lane that waited on nothing has no arrow into it", () => {
    const layout = LaneLayouts.layOut(["a", "b"], [], Option.none());

    expect(layout.edges).toEqual([]);
    expect(LaneLayouts.columns(layout)).toEqual([["a", "b"]]);
  });

  test("a cycle, which no flow should declare, is cut where it closes", () => {
    const layout = LaneLayouts.layOut(
      ["a", "b"],
      [
        { lane: "a", needs: ["b"] },
        { lane: "b", needs: ["a"] },
      ],
      Option.none(),
    );

    expect(layout.lanes.map((lane) => lane.column)).toEqual([2, 1]);
  });
});
