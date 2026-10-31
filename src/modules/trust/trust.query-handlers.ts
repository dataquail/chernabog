import { Query } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { checkTrustHandler } from "./queries/check-trust.handler.ts";
import { CheckTrustQuery } from "./queries/check-trust.query.ts";
import { findTrustedTreeHandler } from "./queries/find-trusted-tree.handler.ts";
import { FindTrustedTreeQuery } from "./queries/find-trusted-tree.query.ts";

export const trustQueryGroup = Query.group(CheckTrustQuery, FindTrustedTreeQuery);

const TrustQueryHandlersLive = Query.handlersOf(trustQueryGroup, {
  CheckTrustQuery: (payload) => checkTrustHandler(payload),
  FindTrustedTreeQuery: (payload) => findTrustedTreeHandler(payload),
});

// The trust module's slice of the read side, which `status`, `doctor` and the
// daemon ask.
export class TrustQueries extends Context.Service<
  TrustQueries,
  Query.Dispatcher<typeof trustQueryGroup>
>()("TrustQueries") {}

export const TrustQueriesLive = Layer.effect(TrustQueries, Query.dispatcher(trustQueryGroup)).pipe(
  Layer.provideMerge(TrustQueryHandlersLive),
);
