import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { TrustRecordsRepository } from "../domain/ports/repositories/trust-records.repository.ts";
import { type FindTrustedTreePayload, TrustedTree } from "./find-trusted-tree.query.ts";

export const findTrustedTreeHandler = Effect.fn("findTrustedTreeHandler")(function* (
  query: FindTrustedTreePayload,
) {
  const record = yield* (yield* TrustRecordsRepository).findOne(query.repo);

  return TrustedTree.make({ repo: query.repo, tree: Option.map(record, (found) => found.tree) });
});
