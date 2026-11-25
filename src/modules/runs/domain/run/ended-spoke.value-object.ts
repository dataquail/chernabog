import { type AgentSessionOpened } from "./agent-session-opened.value-object.ts";
import { type RunStatus } from "./run-status.value-object.ts";

// A run's spoke, once it was ended (ADR 23, decision 5): the ending it was
// ended for, which is the first one asked of it, however many ask; how its
// process exited (`killed by SIGTERM`); and the agent sessions it reported
// opening.
export type EndedSpoke = {
  readonly endedFor: RunStatus;
  readonly exit: string;
  readonly sessions: ReadonlyArray<AgentSessionOpened>;
};
