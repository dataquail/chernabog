import { Command } from "@effect-server-utils/cqrs";

import { RunId } from "../../../kernel/run-id.id.ts";
import { FlowPlan } from "../domain/plan/flow-plan.value-object.ts";

// A run keeping the plan of the flow it runs, as its run starts: kept once by
// its hash, which runs of the same plan share. A run keeps the plan it
// started with: saving another for it, as a resumed run does, changes nothing.
export const SaveRunPlanCommand = Command.make("SaveRunPlanCommand", {
  payload: { runId: RunId, plan: FlowPlan },
});

export type SaveRunPlanPayload = Command.Payload<typeof SaveRunPlanCommand>;
