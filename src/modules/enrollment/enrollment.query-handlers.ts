import { Query } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { EnrollmentLayer } from "./enrollment.layer.ts";
import { findCheckoutRootHandler } from "./queries/find-checkout-root.handler.ts";
import { FindCheckoutRootQuery } from "./queries/find-checkout-root.query.ts";
import { listEnrolledReposHandler } from "./queries/list-enrolled-repos.handler.ts";
import { ListEnrolledReposQuery } from "./queries/list-enrolled-repos.query.ts";
import { listMovedReposHandler } from "./queries/list-moved-repos.handler.ts";
import { ListMovedReposQuery } from "./queries/list-moved-repos.query.ts";
import { listPausedReposHandler } from "./queries/list-paused-repos.handler.ts";
import { ListPausedReposQuery } from "./queries/list-paused-repos.query.ts";
import { listPersonasInUseHandler } from "./queries/list-personas-in-use.handler.ts";
import { ListPersonasInUseQuery } from "./queries/list-personas-in-use.query.ts";
import { planEnrollmentHandler } from "./queries/plan-enrollment.handler.ts";
import { PlanEnrollmentQuery } from "./queries/plan-enrollment.query.ts";

export const enrollmentQueryGroup = Query.group(
  FindCheckoutRootQuery,
  ListEnrolledReposQuery,
  ListMovedReposQuery,
  ListPausedReposQuery,
  ListPersonasInUseQuery,
  PlanEnrollmentQuery,
);

const EnrollmentQueryHandlersLive = Query.handlersOf(enrollmentQueryGroup, {
  FindCheckoutRootQuery: (payload) => findCheckoutRootHandler(payload),
  ListEnrolledReposQuery: (payload) => listEnrolledReposHandler(payload),
  ListMovedReposQuery: (payload) => listMovedReposHandler(payload),
  ListPausedReposQuery: () => listPausedReposHandler(),
  ListPersonasInUseQuery: () => listPersonasInUseHandler(),
  PlanEnrollmentQuery: (payload) => planEnrollmentHandler(payload),
}).pipe(Layer.provide(EnrollmentLayer));

// The enrollment module's slice of the read side, which enroll, init, setup,
// status, trust and the daemon ask.
export class EnrollmentQueries extends Context.Service<
  EnrollmentQueries,
  Query.Dispatcher<typeof enrollmentQueryGroup>
>()("EnrollmentQueries") {}

export const EnrollmentQueriesLive = Layer.effect(
  EnrollmentQueries,
  Query.dispatcher(enrollmentQueryGroup),
).pipe(Layer.provideMerge(EnrollmentQueryHandlersLive));
