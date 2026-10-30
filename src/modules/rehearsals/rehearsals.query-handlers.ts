import { Query } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { checkRehearsalHandler } from "./queries/check-rehearsal.handler.ts";
import { CheckRehearsalQuery } from "./queries/check-rehearsal.query.ts";
import { chooseSeededWorkHandler } from "./queries/choose-seeded-work.handler.ts";
import { ChooseSeededWorkQuery } from "./queries/choose-seeded-work.query.ts";
import { loadScenarioHandler } from "./queries/load-scenario.handler.ts";
import { LoadScenarioQuery } from "./queries/load-scenario.query.ts";
import { planRehearsalHandler } from "./queries/plan-rehearsal.handler.ts";
import { PlanRehearsalQuery } from "./queries/plan-rehearsal.query.ts";
import { RehearsalsLayer } from "./rehearsals.layer.ts";

export const rehearsalsQueryGroup = Query.group(
  CheckRehearsalQuery,
  ChooseSeededWorkQuery,
  LoadScenarioQuery,
  PlanRehearsalQuery,
);

const RehearsalsQueryHandlersLive = Query.handlersOf(rehearsalsQueryGroup, {
  CheckRehearsalQuery: (payload) => checkRehearsalHandler(payload),
  ChooseSeededWorkQuery: (payload) => chooseSeededWorkHandler(payload),
  LoadScenarioQuery: (payload) => loadScenarioHandler(payload),
  PlanRehearsalQuery: (payload) => planRehearsalHandler(payload),
}).pipe(Layer.provide(RehearsalsLayer));

// The rehearsals module's slice of the read side, which `rehearse` asks.
export class RehearsalsQueries extends Context.Service<
  RehearsalsQueries,
  Query.Dispatcher<typeof rehearsalsQueryGroup>
>()("RehearsalsQueries") {}

export const RehearsalsQueriesLive = Layer.effect(
  RehearsalsQueries,
  Query.dispatcher(rehearsalsQueryGroup),
).pipe(Layer.provideMerge(RehearsalsQueryHandlersLive));
