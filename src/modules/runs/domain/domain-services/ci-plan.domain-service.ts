// What a repo's CI plan job starts (#459): the rules plan-tick.handler.ts
// applies on a daemon's tick, without state.db. Whether an item already has a
// run comes from the claim refs, and the flow's concurrency counts the live
// claims its runs hold; what a tick would record as a skip or a hold is said
// as a note, for the job's summary.

import type * as Option from "effect/Option";

import { type WorkItem } from "../run/work-item.value-object.ts";

// The work item an event concerns, as its payload names it (the SDK's
// Events.EventItem): an issue or pull request by number, a branch, an item by
// its claim's name, or none in particular.
export type EventItem =
  | { readonly kind: "issue" | "pull-request"; readonly number: number }
  | { readonly kind: "branch" | "item"; readonly name: string }
  | { readonly kind: "repo" };

// A flow an event wakes, for one persona, and the item it concerns.
export type Woken = {
  readonly flow: string;
  readonly persona: string;
  readonly item: EventItem;
};

// A flow the repo runs in CI, and the logins it runs as.
export type CiFlow = { readonly flow: string; readonly personas: ReadonlyArray<string> };

// What a plan looks at: every item (the sweep), or what an event wakes.
export type Scope =
  { readonly kind: "sweep" } | { readonly kind: "event"; readonly woken: ReadonlyArray<Woken> };

// One flow as one persona, and the items it looks at: every one, or those named.
export type Target = {
  readonly flow: string;
  readonly persona: string;
  readonly only: Option.Option<ReadonlyArray<EventItem>>;
};

// A claim whose lease hasn't run out, and whose run holds it.
export type LiveClaim = {
  readonly item: string;
  readonly runId: string;
  readonly flow: string;
  readonly persona: string;
};

// What a target's trigger found, the flow's concurrency, and why its gate
// holds its runs back, if it does.
export type Findings = {
  readonly target: Target;
  readonly concurrency: number;
  readonly found:
    | { readonly kind: "items"; readonly items: ReadonlyArray<WorkItem> }
    | { readonly kind: "failed"; readonly reason: string };
  readonly held: Option.Option<string>;
};

// One job of the run's matrix.
export type Entry = { readonly flow: string; readonly persona: string; readonly item: string };

export type Planned = {
  readonly start: ReadonlyArray<Entry>;
  readonly notes: ReadonlyArray<string>;
};

const targets = (_flows: ReadonlyArray<CiFlow>, _scope: Scope): ReadonlyArray<Target> => [];

const concerns = (_item: EventItem, _key: string) => false;

const resolveBranch = (
  _name: string,
  _pullRequest: Option.Option<number>,
): ReadonlyArray<EventItem> => [];

const startable = (
  _findings: Findings,
  _claims: ReadonlyArray<LiveClaim>,
): ReadonlyArray<WorkItem> => [];

const plan = (_findings: ReadonlyArray<Findings>, _claims: ReadonlyArray<LiveClaim>): Planned => ({
  start: [],
  notes: [],
});

const matrix = (_start: ReadonlyArray<Entry>) => "";

export const CiPlan = { targets, concerns, resolveBranch, startable, plan, matrix } as const;
