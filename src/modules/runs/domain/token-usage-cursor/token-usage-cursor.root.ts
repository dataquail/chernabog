import * as Schema from "effect/Schema";

// How far an adapter has read one agent session's own records of what it
// spent, in a form only that adapter understands. Sessions cross runs (a
// resumed author's session, a hybrid's session by issue), so each call
// charges only what it added since the cursor. One per adapter and session.
export class TokenUsageCursorRoot extends Schema.Class<
  TokenUsageCursorRoot,
  { readonly brand: "TokenUsageCursorRoot" }
>("TokenUsageCursorRoot")({
  adapter: Schema.String,
  sessionId: Schema.String,
  cursor: Schema.String,
}) {}
