// What this machine offers a repo's personas, as machine setup reports it.
export type Offered = {
  readonly personas: ReadonlyArray<string>;
  readonly accounts: ReadonlyArray<{ readonly name: string; readonly agent: string }>;
};

// An enrolled repo, as the use-cases that change one return it.
export { EnrolledRepoSummary } from "../domain/enrolled-repo/enrolled-repo-summary.value-object.ts";

// Why a flow is off when a person turned it off for a persona: a reason they
// know, so a presenter needn't repeat it.
export { FLOW_TURNED_OFF } from "../domain/enrolled-repo/team-flows.value-object.ts";
