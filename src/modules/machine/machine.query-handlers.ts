import { Query } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { checkServiceHandler } from "./queries/check-service.handler.ts";
import { CheckServiceQuery } from "./queries/check-service.query.ts";
import { inspectAccountDirHandler } from "./queries/inspect-account-dir.handler.ts";
import { InspectAccountDirQuery } from "./queries/inspect-account-dir.query.ts";
import { planAppHandler } from "./queries/plan-app.handler.ts";
import { PlanAppQuery } from "./queries/plan-app.query.ts";
import { planSetupHandler } from "./queries/plan-setup.handler.ts";
import { PlanSetupQuery } from "./queries/plan-setup.query.ts";
import { readMachineSetupHandler } from "./queries/read-machine-setup.handler.ts";
import { ReadMachineSetupQuery } from "./queries/read-machine-setup.query.ts";

export const machineQueryGroup = Query.group(
  CheckServiceQuery,
  InspectAccountDirQuery,
  PlanAppQuery,
  PlanSetupQuery,
  ReadMachineSetupQuery,
);

const MachineQueryHandlersLive = Query.handlersOf(machineQueryGroup, {
  CheckServiceQuery: () => checkServiceHandler(),
  InspectAccountDirQuery: (payload) => inspectAccountDirHandler(payload),
  PlanAppQuery: (payload) => planAppHandler(payload),
  PlanSetupQuery: () => planSetupHandler(),
  ReadMachineSetupQuery: () => readMachineSetupHandler(),
});

// The machine module's slice of the read side, which setup, enroll, doctor
// and the TUI ask.
export class MachineQueries extends Context.Service<
  MachineQueries,
  Query.Dispatcher<typeof machineQueryGroup>
>()("MachineQueries") {}

export const MachineQueriesLive = Layer.effect(
  MachineQueries,
  Query.dispatcher(machineQueryGroup),
).pipe(Layer.provideMerge(MachineQueryHandlersLive));
