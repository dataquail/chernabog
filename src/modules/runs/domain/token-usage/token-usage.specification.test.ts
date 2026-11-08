import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { Criteria } from "../../../../kernel/specification.ts";
import { TokenUsageRoot } from "./token-usage.root.ts";
import { TokenUsageSpecifications } from "./token-usage.specification.ts";

const usage = (runId: string, model: string) =>
  TokenUsageRoot.make({
    runId: RunId.make(runId),
    step: Option.none(),
    adapter: "claude",
    sessionId: "s",
    model: Option.some(model),
    input: Option.some(1),
    output: Option.none(),
    cacheRead: Option.none(),
    cacheWrite: Option.none(),
    reported: true,
    recordedAt: "t",
  });

describe("TokenUsageSpecifications", () => {
  const usages = [usage("a", "opus"), usage("b", "opus"), usage("a", "haiku")];

  test("forRun holds of what one run's calls spent, as an Eq on runId", () => {
    expect(usages.filter(TokenUsageSpecifications.forRun(RunId.make("a")))).toEqual([
      usages[0],
      usages[2],
    ]);
    expect(TokenUsageSpecifications.forRun(RunId.make("a")).criteria).toEqual(
      Criteria.Eq({ field: "runId", value: "a" }),
    );
  });
});
