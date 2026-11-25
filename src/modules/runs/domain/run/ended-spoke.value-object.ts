import { type AgentSessionOpened } from "./agent-session-opened.value-object.ts";

// A run's spoke, once it was ended (ADR 23, decision 5): how its process
// exited (`killed by SIGTERM`), and the agent sessions it reported opening.
export type EndedSpoke = {
  readonly exit: string;
  readonly sessions: ReadonlyArray<AgentSessionOpened>;
};
