// The platform surface: what the composition roots and the inbound adapters name to
// assemble and drive this module — its dispatchers, its Layers, and the results and
// value objects its messages answer with. It declares nothing; anything not
// re-exported here is private to the module.

export { type Enrolled } from "./commands/apply-enrollment.command.ts";
export { type PauseState } from "./commands/pause-repo.command.ts";
export { FLOW_TURNED_OFF } from "./domain/enrolled-repo/team-flows.value-object.ts";
export { EnrollmentCommands, EnrollmentCommandsLive } from "./enrollment.command-handlers.ts";
export { EnrollmentLayer } from "./enrollment.layer.ts";
export { EnrollmentQueries, EnrollmentQueriesLive } from "./enrollment.query-handlers.ts";
export { type EnrollmentPlan, type PersonaPlan } from "./queries/plan-enrollment.query.ts";
