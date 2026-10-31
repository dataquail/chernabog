import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type PersistenceFailed } from "../../../../kernel/persistence.errors.ts";
import { type Specification } from "../../../../kernel/specification.ts";
import { type TrustRecordRoot } from "./trust-record.root.ts";

// Each repo's trust record, one per slug. A store that can't be read trusts
// nothing, so `findOne` never fails: a repo it can't vouch for stays stopped.
// `upsertOne` replaces the repo's record, or adds it.
export type TrustRecordsRepositoryService = {
  readonly findOne: (
    spec: Specification<TrustRecordRoot>,
  ) => Effect.Effect<Option.Option<TrustRecordRoot>>;
  readonly upsertOne: (record: TrustRecordRoot) => Effect.Effect<void, PersistenceFailed>;
};

export class TrustRecordsRepository extends Context.Service<
  TrustRecordsRepository,
  TrustRecordsRepositoryService
>()("TrustRecordsRepository") {}
