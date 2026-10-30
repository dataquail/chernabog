import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ConfigTreeClient } from "../domain/ports/clients/config-tree.client.ts";
import { TrustRecordsRepository } from "../domain/ports/repositories/trust-records.repository.ts";
import { TrustRecordRootOps } from "../domain/trust-record/trust-record.root-ops.ts";
import { type CheckTrustPayload, TrustCheck } from "./check-trust.query.ts";

export const checkTrustHandler = Effect.fn("checkTrustHandler")(function* (
  query: CheckTrustPayload,
) {
  const tree = yield* Effect.option((yield* ConfigTreeClient).localTreeOf(query.path));

  const record = yield* (yield* TrustRecordsRepository).findOne(query.repo);

  return TrustCheck.make({
    repo: query.repo,
    tree,
    trusted: Option.exists(tree, (found) => TrustRecordRootOps.trusts(record, found)),
  });
});
