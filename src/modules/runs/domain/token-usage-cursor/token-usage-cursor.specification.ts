import { Spec, type Specification } from "../../../../kernel/specification.ts";
import { type TokenUsageCursorRoot } from "./token-usage-cursor.root.ts";

// The cursor of one adapter's session.
const forSession = (adapter: string, sessionId: string): Specification<TokenUsageCursorRoot> =>
  Spec.and(
    Spec.eq<TokenUsageCursorRoot, "adapter">("adapter", adapter),
    Spec.eq<TokenUsageCursorRoot, "sessionId">("sessionId", sessionId),
  );

export const TokenUsageCursorSpecifications = { forSession } as const;
