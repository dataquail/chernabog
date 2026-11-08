import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

// How far an adapter has read one session's records of what it spent: the
// cursor its last recorded call left, or none for a session never read.
export class TokenUsageCursorView extends Schema.Class<
  TokenUsageCursorView,
  { readonly brand: "TokenUsageCursorView" }
>("TokenUsageCursorView")({ cursor: Schema.Option(Schema.String) }) {}

// The cursor an agent call reads its session's usage on from, before it starts.
export const ReadTokenUsageCursorQuery = Query.make("ReadTokenUsageCursorQuery", {
  payload: { adapter: Schema.String, sessionId: Schema.String },
  success: TokenUsageCursorView,
});

export type ReadTokenUsageCursorPayload = Query.Payload<typeof ReadTokenUsageCursorQuery>;
