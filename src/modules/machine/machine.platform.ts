// The platform surface: what the composition roots and the inbound adapters name to
// assemble and drive this module — its dispatchers, its Layers, and the results and
// value objects its messages answer with. It declares nothing; anything not
// re-exported here is private to the module.

export { type SetupOutcome } from "./commands/apply-setup.command.ts";
export { MachineCommands, MachineCommandsLive } from "./machine.command-handlers.ts";
export { MachineLayer } from "./machine.layer.ts";
export { MachineQueries, MachineQueriesLive } from "./machine.query-handlers.ts";
export { type SetupPlan } from "./queries/plan-setup.query.ts";
