// Where the URL's hash puts the page.

import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { nodeHref, type NodePlace, routeOf, runHref, stepHref, tabHref } from "./routes.ts";

describe("the page's routes", () => {
  test("home is the runs in flight, and an unknown hash goes home", () => {
    expect(routeOf("")).toEqual({ kind: "tab", tab: "active" });
    expect(routeOf("#/")).toEqual({ kind: "tab", tab: "active" });
    expect(routeOf("#/nowhere")).toEqual({ kind: "tab", tab: "active" });
  });

  test("names each tab, and each tab links back to itself", () => {
    for (const tab of ["active", "recent", "flows", "repos"] as const) {
      expect(routeOf(tabHref(tab))).toEqual({ kind: "tab", tab });
    }
  });

  test("names a run, and a step of it, by what their links say", () => {
    expect(routeOf(runHref("8673"))).toEqual({ kind: "run", runId: "8673", step: Option.none() });
    expect(routeOf(stepHref("8673", "implement#task-284"))).toEqual({
      kind: "run",
      runId: "8673",
      step: Option.some("implement#task-284"),
    });
  });

  test("names a node of a run's plan, in its round and its lane, and set up and wrap up", () => {
    const places: ReadonlyArray<NodePlace> = [
      { kind: "node", id: "review", round: Option.none(), lane: Option.none() },
      { kind: "node", id: "ci", round: Option.some(2), lane: Option.none() },
      { kind: "node", id: "ci", round: Option.some(2), lane: Option.some("task 10/b") },
      {
        kind: "node",
        id: "steps[3].repeat.steps[5].if",
        round: Option.none(),
        lane: Option.some("x"),
      },
      { kind: "set-up" },
      { kind: "wrap-up" },
    ];

    for (const place of places) {
      expect(routeOf(nodeHref("8673", place))).toEqual({ kind: "node", runId: "8673", place });
    }

    expect(nodeHref("8673", places[2])).toBe("#/runs/8673/nodes/ci/rounds/2/lanes/task%2010%2Fb");
    expect(nodeHref("8673", { kind: "set-up" })).toBe("#/runs/8673/set-up");
  });

  test("takes a hash that isn't valid percent-encoding as it is", () => {
    expect(routeOf("#/runs/%E0%A4%A")).toEqual({
      kind: "run",
      runId: "%E0%A4%A",
      step: Option.none(),
    });
  });
});
