import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { type Specification } from "../../../../kernel/specification.ts";
import { type TokenUsageRoot } from "./token-usage.root.ts";

// What runs' agent calls spent: `insertMany` keeps a call's rows, and
// `findMany` reads those a spec (TokenUsageSpecifications) holds of, in the
// order they were recorded.
export type TokenUsagesRepositoryService = {
  readonly findMany: (
    spec: Specification<TokenUsageRoot>,
  ) => Effect.Effect<ReadonlyArray<TokenUsageRoot>>;
  readonly insertMany: (usages: ReadonlyArray<TokenUsageRoot>) => Effect.Effect<void>;
};

export class TokenUsagesRepository extends Context.Service<
  TokenUsagesRepository,
  TokenUsagesRepositoryService
>()("TokenUsagesRepository") {}
