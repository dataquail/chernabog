import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type Specification } from "../../../../kernel/specification.ts";
import { type TokenUsageCursorRoot } from "./token-usage-cursor.root.ts";

// Each session's cursor, read by a spec (TokenUsageCursorSpecifications).
// Upserting one replaces the cursor of its adapter's session.
export type TokenUsageCursorsRepositoryService = {
  readonly findOne: (
    spec: Specification<TokenUsageCursorRoot>,
  ) => Effect.Effect<Option.Option<TokenUsageCursorRoot>>;
  readonly upsertOne: (cursor: TokenUsageCursorRoot) => Effect.Effect<void>;
};

export class TokenUsageCursorsRepository extends Context.Service<
  TokenUsageCursorsRepository,
  TokenUsageCursorsRepositoryService
>()("TokenUsageCursorsRepository") {}
