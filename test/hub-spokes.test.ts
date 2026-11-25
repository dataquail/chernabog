import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import {
  spokeArgs,
  spokeEnvironment,
  type SpokeHandOver,
} from "../src/interface/daemon/spokes.server.ts";
import { RunId } from "../src/kernel/run-id.id.ts";

const handOver = (fields: Partial<SpokeHandOver> = {}): SpokeHandOver => ({
  runId: RunId.make("3f2a"),
  repo: "demo",
  checkout: "/work/demo",
  flow: "implement",
  persona: Option.some("chernabog-bot"),
  item: { key: "issue-7", data: { issue: 7 } },
  tree: Option.some("abc123"),
  ...fields,
});

describe("a spoke's hand-over", () => {
  test("is `ci run --run` with the run, its repo, flow, persona, item and tree", () => {
    expect(spokeArgs(handOver(), "/home/spokes/3f2a.item.json")).toEqual([
      "ci",
      "run",
      "--run",
      "3f2a",
      "--repo",
      "demo",
      "--flow",
      "implement",
      "--persona",
      "chernabog-bot",
      "--item",
      "issue-7",
      "--work-item-file",
      "/home/spokes/3f2a.item.json",
      "--tree",
      "abc123",
    ]);
  });

  test("names no persona for the implicit one, and no tree for a working copy's", () => {
    const args = spokeArgs(
      handOver({ persona: Option.none(), tree: Option.none() }),
      "/home/spokes/3f2a.item.json",
    );

    expect(args).not.toContain("--persona");
    expect(args).not.toContain("--tree");
  });

  test("runs in the hub's home, and never with an API key, which bills claude by the token", () => {
    expect(
      spokeEnvironment(
        { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant", CHERNABOG_HOME: "/elsewhere" },
        "/home",
      ),
    ).toEqual({ PATH: "/usr/bin", CHERNABOG_HOME: "/home" });
  });
});
