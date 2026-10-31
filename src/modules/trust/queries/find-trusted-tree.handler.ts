import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { TrustRecordSpecifications } from "../domain/trust-record/trust-record.specification.ts";
import { TrustRecordsRepository } from "../domain/trust-record/trust-records.repository.ts";
import { type FindTrustedTreePayload, TrustedTree } from "./find-trusted-tree.query.ts";

export const findTrustedTreeHandler = Effect.fn("findTrustedTreeHandler")(function* (
  query: FindTrustedTreePayload,
) {
  const record = yield* (yield* TrustRecordsRepository).findOne(
    TrustRecordSpecifications.forRepo(query.repo),
  );

  return TrustedTree.make({ repo: query.repo, tree: Option.map(record, (found) => found.tree) });
});
