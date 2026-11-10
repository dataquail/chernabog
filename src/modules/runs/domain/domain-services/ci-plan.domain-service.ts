// What a repo's CI plan job starts (#459): the rules plan-tick.handler.ts
// applies on a daemon's tick, without state.db. Whether an item already has a
// run comes from the claim refs, and the flow's concurrency counts the live
// claims its runs hold; what a tick would record as a skip or a hold is said
// as a note, for the job's summary.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  claimOf,
  describeWaiting,
  itemTarget,
  mayStart,
  type WorkItem,
} from "../run/work-item.value-object.ts";
import { Routing } from "./routing.domain-service.ts";

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

const sameLogin = (one: string, other: string) => one.toLowerCase() === other.toLowerCase();

// The flows and personas a plan runs the trigger of, in the order config
// names the flows, and the items each looks at. The sweep looks at every item
// of every flow; an event only at the flows it wakes, for the personas it
// wakes them for, and at the items it concerns, or every item when one of its
// routes names none. An event a guard refused wakes nothing, so nothing runs.
const targets = (flows: ReadonlyArray<CiFlow>, scope: Scope): ReadonlyArray<Target> =>
  flows.flatMap((ci) =>
    ci.personas.flatMap((persona): ReadonlyArray<Target> => {
      if (scope.kind === "sweep") {
        return [{ flow: ci.flow, persona, only: Option.none() }];
      }

      const items = scope.woken
        .filter((woken) => woken.flow === ci.flow && sameLogin(woken.persona, persona))
        .map((woken) => woken.item);

      if (items.length === 0) {
        return [];
      }

      if (items.some((one) => one.kind === "repo")) {
        return [{ flow: ci.flow, persona, only: Option.none() }];
      }

      return [{ flow: ci.flow, persona, only: Option.some(items) }];
    }),
  );

// The claim a run on an item holds: the issue's or pull request's, by the
// SDK's names, or the key itself for an item of a flow's own.
const claimName = (key: string) =>
  Option.match(itemTarget(key), { onNone: () => key, onSome: claimOf });

// Whether an event's item is the work item with this key. A branch names no
// key: resolveBranch turns it into what it does name first.
const concerns = (concerned: EventItem, key: string) => {
  switch (concerned.kind) {
    case "repo":
      return true;
    case "issue":
    case "pull-request":
      return Option.exists(
        itemTarget(key),
        (target) => target.kind === concerned.kind && target.number === concerned.number,
      );
    case "item":
      return key === concerned.name || claimName(key) === concerned.name;
    case "branch":
      return false;
  }
};

const ISSUE_BRANCH = /^auto\/issue-(\d+)$/;

// What a branch names: the pull request open from it, and the issue whose work
// branch it is, by the SDK's name for one (`auto/issue-<n>`).
const resolveBranch = (
  name: string,
  pullRequest: Option.Option<number>,
): ReadonlyArray<EventItem> => [
  ...Option.toArray(
    Option.map(pullRequest, (number): EventItem => ({ kind: "pull-request", number })),
  ),
  ...Option.toArray(
    Option.map(Option.fromNullOr(ISSUE_BRANCH.exec(name)), (found): EventItem => ({
      kind: "issue",
      number: Number(found[1]),
    })),
  ),
];

const describeConcerned = (concerned: EventItem) => {
  switch (concerned.kind) {
    case "repo":
      return "the repo";
    case "issue":
      return `issue-${concerned.number}`;
    case "pull-request":
      return `pr-${concerned.number}`;
    case "item":
    case "branch":
      return concerned.name;
  }
};

const labelOf = (target: { readonly flow: string; readonly persona: string }) =>
  `${target.flow} as ${target.persona}`;

const liveClaimOn = (claims: ReadonlyArray<LiveClaim>, key: string) =>
  Arr.findFirst(claims, (live) => live.item === claimName(key));

// The items a target's trigger found that it looks at.
const lookedAt = (findings: Findings): ReadonlyArray<WorkItem> => {
  if (findings.found.kind === "failed") {
    return [];
  }

  const only = findings.target.only;

  return findings.found.items.filter((found) =>
    Option.match(only, {
      onNone: () => true,
      onSome: (named) => named.some((concerned) => concerns(concerned, found.key)),
    }),
  );
};

// What a target could start before its gate and its concurrency: the items it
// looks at that may start, whose item has no live claim, and that its flow
// left for no one else. Only a flow with any has its gate asked.
const startable = (findings: Findings, claims: ReadonlyArray<LiveClaim>) =>
  Routing.split(
    lookedAt(findings).filter(
      (found) => mayStart(found) && Option.isNone(liveClaimOn(claims, found.key)),
    ),
  ).mine;

const keysOf = (items: ReadonlyArray<WorkItem>) => items.map((found) => found.key).join(", ");

// One target's part of the plan, given what the targets before it planned.
const planOne = (
  findings: Findings,
  claims: ReadonlyArray<LiveClaim>,
  planned: ReadonlyArray<Entry>,
): Planned => {
  const label = labelOf(findings.target);

  if (findings.found.kind === "failed") {
    return { start: [], notes: [`${label}: trigger failed: ${findings.found.reason}`] };
  }

  const items = lookedAt(findings);

  if (items.length === 0) {
    return {
      start: [],
      notes: [
        Option.match(findings.target.only, {
          onNone: () => `${label}: its trigger found no work`,
          onSome: (named) =>
            `${label}: its trigger reports no work for ${named.map(describeConcerned).join(", ")}`,
        }),
      ],
    };
  }

  const held = items.flatMap((found) =>
    Option.toArray(
      Option.map(
        Option.fromUndefinedOr(found.held),
        (reason) => `${label}: ${found.key} is held: ${reason}`,
      ),
    ),
  );

  const waiting = items.flatMap((found) =>
    Option.toArray(Option.map(describeWaiting(found), (said) => `${label}: ${said}`)),
  );

  const free = items.filter(mayStart);

  const running = free.flatMap((found) =>
    Option.toArray(
      Option.map(
        liveClaimOn(claims, found.key),
        (live) => `${label}: ${found.key} has a run already (${live.runId}, ${labelOf(live)})`,
      ),
    ),
  );

  const unclaimed = free.filter((found) => Option.isNone(liveClaimOn(claims, found.key)));

  const twice = unclaimed.flatMap((found) =>
    Option.toArray(
      Option.map(
        Arr.findFirst(planned, (entry) => claimName(entry.item) === claimName(found.key)),
        (entry) => `${label}: ${found.key} is planned for ${labelOf(entry)}`,
      ),
    ),
  );

  const routed = Routing.split(
    unclaimed.filter(
      (found) => !planned.some((entry) => claimName(entry.item) === claimName(found.key)),
    ),
  );

  const elsewhere = Option.toArray(
    Option.map(
      Option.liftPredicate(routed.elsewhere, Arr.isReadonlyArrayNonEmpty),
      (left) => `${label}: left for others: ${left.map(Routing.describeElsewhere).join(", ")}`,
    ),
  );

  const notes = [...held, ...waiting, ...running, ...twice, ...elsewhere];
  const candidates = routed.mine;

  if (candidates.length === 0) {
    return { start: [], notes };
  }

  if (Option.isSome(findings.held)) {
    return {
      start: [],
      notes: [
        ...notes,
        `${label}: held back: ${findings.held.value}; waiting: ${keysOf(candidates)}`,
      ],
    };
  }

  const active = claims.filter(
    (live) =>
      live.flow === findings.target.flow && sameLogin(live.persona, findings.target.persona),
  ).length;

  const slots = Math.max(0, findings.concurrency - active);
  const chosen = candidates.slice(0, slots);
  const left = candidates.slice(slots);

  const capped = Option.toArray(
    Option.map(Option.liftPredicate(left, Arr.isReadonlyArrayNonEmpty), (over) => {
      if (slots === 0) {
        return `${label}: at its concurrency of ${findings.concurrency}; waiting: ${keysOf(over)}`;
      }

      return `${label}: over its concurrency of ${findings.concurrency}; waiting: ${keysOf(over)}`;
    }),
  );

  return {
    start: chosen.map((found) => ({
      flow: findings.target.flow,
      persona: findings.target.persona,
      item: found.key,
    })),
    notes: [...notes, ...capped],
  };
};

// The jobs a plan starts, in the order of the flows and of each trigger's
// items, each flow capped by its concurrency less the live claims its runs
// hold; and, for the job's summary, why everything else starts nothing.
const plan = (findings: ReadonlyArray<Findings>, claims: ReadonlyArray<LiveClaim>): Planned =>
  findings.reduce<Planned>(
    (sofar, one) => {
      const next = planOne(one, claims, sofar.start);

      return { start: [...sofar.start, ...next.start], notes: [...sofar.notes, ...next.notes] };
    },
    { start: [], notes: [] },
  );

// The matrix as the workflow reads it: exactly `[]` when it starts nothing,
// which the run job's guard compares against (docs/ci/runner-test.md).
const MatrixText = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ flow: Schema.String, persona: Schema.String, item: Schema.String })),
);

const matrix = (start: ReadonlyArray<Entry>) =>
  Schema.encodeSync(MatrixText)(
    start.map((entry) => ({ flow: entry.flow, persona: entry.persona, item: entry.item })),
  );

export const CiPlan = { targets, concerns, resolveBranch, startable, plan, matrix } as const;
