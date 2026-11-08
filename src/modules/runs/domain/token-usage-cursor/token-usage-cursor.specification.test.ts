import { describe, expect, test } from "bun:test";

import { Criteria } from "../../../../kernel/specification.ts";
import { TokenUsageCursorRoot } from "./token-usage-cursor.root.ts";
import { TokenUsageCursorSpecifications } from "./token-usage-cursor.specification.ts";

const cursor = (adapter: string, sessionId: string) =>
  TokenUsageCursorRoot.make({ adapter, sessionId, cursor: "c" });

describe("TokenUsageCursorSpecifications", () => {
  const cursors = [cursor("claude", "s1"), cursor("codex", "s1"), cursor("claude", "s2")];

  test("forSession holds of one adapter's session, by both", () => {
    expect(cursors.filter(TokenUsageCursorSpecifications.forSession("claude", "s1"))).toEqual([
      cursors[0],
    ]);
    expect(TokenUsageCursorSpecifications.forSession("claude", "s1").criteria).toEqual(
      Criteria.And({
        nodes: [
          Criteria.Eq({ field: "adapter", value: "claude" }),
          Criteria.Eq({ field: "sessionId", value: "s1" }),
        ],
      }),
    );
  });
});
