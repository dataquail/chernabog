import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type PersistenceFailed } from "../../../../../kernel/persistence.errors.ts";
import { type RepoSlug } from "../../../../../kernel/repo-slug.id.ts";
import { type TrustRecordRoot } from "../../trust-record/trust-record.root.ts";

// Each repo's trust record, by slug. A store that can't be read trusts
// nothing, so `findOne` never fails: a repo it can't vouch for stays stopped.
export type TrustRecordsRepositoryService = {
  readonly findOne: (repo: RepoSlug) => Effect.Effect<Option.Option<TrustRecordRoot>>;
  readonly save: (record: TrustRecordRoot) => Effect.Effect<void, PersistenceFailed>;
};

export class TrustRecordsRepository extends Context.Service<
  TrustRecordsRepository,
  TrustRecordsRepositoryService
>()("TrustRecordsRepository") {}
