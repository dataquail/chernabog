import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { claimMarker } from "../packages/sdk/src/markers.ts";

describe("claim markers", () => {
  test("still reads a claim posted before markers stopped naming the host", () => {
    const body =
      '<!-- chernabog-claim {"runId":"r1","host":"laptop.local","claimedAt":"2026-10-18T00:00:05.839Z","branch":"auto/issue-1"} -->';

    expect(Option.getOrThrow(claimMarker.read(body)).runId).toBe("r1");
  });

  test("writes no host", () => {
    expect(
      claimMarker.write({
        runId: "r1",
        claimedAt: "2026-10-18T00:00:05.839Z",
        branch: "auto/issue-1",
      }),
    ).not.toContain("host");
  });
});
