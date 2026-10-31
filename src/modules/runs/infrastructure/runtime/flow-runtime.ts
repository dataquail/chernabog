import * as Layer from "effect/Layer";

import { Exec } from "../../../../platform/exec.ts";
import { type FlowRegistry, FlowsClientLive } from "../clients/flows.client-live.ts";
import { RunCleanupClientLive } from "../clients/run-cleanup.client-live.ts";
import { WorkflowsClientLive } from "../clients/workflows.client-live.ts";
import { RunsRepositoryLive } from "../repositories/runs.repository-live.ts";

// The runtime a tick and a run drive: the flows a process loaded, with each
// persona's services, their workflows in the engine it runs, and cleaning up
// after a run that's cancelled. Which flows those are is the composition
// root's (the daemon's, a foreground run's, a rehearsal's, a cancel's), so each
// root provides this beneath the runs module, inside its engine.
export const RuntimeLayer = (registry: FlowRegistry) =>
  Layer.mergeAll(
    FlowsClientLive(registry),
    WorkflowsClientLive(registry.handles),
    RunCleanupClientLive(registry.services).pipe(Layer.provide(Exec.layer)),
  ).pipe(Layer.provide(RunsRepositoryLive));
