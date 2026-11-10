// The GitHub events that can change what a flow's trigger finds, so a repo's
// workflow can run the plan job when one happens rather than only on its
// schedule (#455, #457). The catalogue declares them, as it declares the
// phases each source reads: each source names the events it depends on, and
// each block whose wakes find parked runs the events that settle the wait.
// A flow written in TypeScript declares its own with the same values, through
// `declare`.
//
// Each declaration also says how the event's payload names the work item, so
// the plan job can look at that one item rather than the whole repo, and
// which guards it keeps: that whoever caused the event is the repo's owner, a
// member or a collaborator, and that it wasn't the flow's own persona, so a
// flow doesn't wake itself in a loop. Both apply unless a declaration opts out.
//
// Phase advances aren't declared: a phase writer sends `repository_dispatch`
// `chernabog-phase`, and that wakes every flow whose sources read phases.
// `check_suite` can't be declared: GitHub starts no workflow for a check suite
// that Actions created, so waiting on CI is `workflow_run: completed`, filtered
// to the repo's CI workflows. Nor can `pull_request_target`: an agent never
// runs on it.

import type { Flow, Json } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

// The events a flow can declare.
export const EVENT_NAMES = [
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "workflow_run",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

// What a phase writer sends after an advance, which wakes every flow whose
// sources read phases.
export const PHASE_EVENT = "repository_dispatch";

export const PHASE_TYPE = "chernabog-phase";

// The associations that may cause an event a guarded declaration wakes on.
export const TRUSTED = ["OWNER", "MEMBER", "COLLABORATOR"] as const;

// How an event's payload names the work item, by a dotted path into it:
// - issue, pull-request: the number at the path;
// - branch: the branch named at the path, such as a CI run's head branch;
// - item: the item's claim name at the path, `pr-7`, as a phase event says it;
// - repo: no one item, so the plan job looks at every one, as its sweep does.
export const ItemFrom = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["issue", "pull-request"]), path: Schema.String }),
  Schema.Struct({ kind: Schema.Literals(["branch", "item"]), path: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("repo") }),
]);

export type ItemFrom = typeof ItemFrom.Type;

// One event a flow wakes on.
export const WakingEvent = Schema.Struct({
  event: Schema.Literals(EVENT_NAMES),
  // Its activity types, the payload's `action`: a workflow's `types:` filter.
  types: Schema.NonEmptyArray(Schema.String),
  item: ItemFrom,
  // Where the payload says how whoever caused it relates to the repo, such as
  // `comment.author_association`. None where only someone with triage or
  // write access can cause it at all, such as labelling an issue.
  association: Schema.optionalKey(Schema.String),
  // Whether it wakes the flow only when that association is OWNER, MEMBER or
  // COLLABORATOR.
  trusted: Schema.Boolean,
  // Whether an event the flow's own persona caused wakes it, as its own merge
  // or its own push's CI run must.
  ownPersona: Schema.Boolean,
});

export type WakingEvent = typeof WakingEvent.Type;

const decodeWaking = Schema.decodeUnknownSync(WakingEvent);

// A declaration, with the guards on unless it says otherwise: refused when
// the module loads if it names an event no flow may wake on.
export const on = (
  event: EventName,
  types: readonly [string, ...Array<string>],
  item: ItemFrom,
  options: {
    readonly association?: string;
    readonly trusted?: boolean;
    readonly ownPersona?: boolean;
  } = {},
): WakingEvent =>
  decodeWaking({
    event,
    types,
    item,
    ...Option.match(Option.fromUndefinedOr(options.association), {
      onNone: () => ({}),
      onSome: (association) => ({ association }),
    }),
    trusted: options.trusted ?? true,
    ownPersona: options.ownPersona ?? false,
  });

const issueNumber: ItemFrom = { kind: "issue", path: "issue.number" };
const pullRequestNumber: ItemFrom = { kind: "pull-request", path: "pull_request.number" };

// The events the catalogue's sources and wakes declare, which a flow written
// in TypeScript declares too, by what its trigger reads.

// A label on an issue, which queues it: only someone with triage access can
// apply one.
export const issueLabelled = on("issues", ["labeled"], issueNumber);

// A review asked of someone, or a draft marked ready, on a pull request whose
// author the repo trusts.
export const reviewRequested = on(
  "pull_request",
  ["review_requested", "ready_for_review"],
  pullRequestNumber,
  { association: "pull_request.author_association" },
);

// A review asked again, of a pull request whose author the repo trusts.
export const reviewRequestedAgain = on("pull_request", ["review_requested"], pullRequestNumber, {
  association: "pull_request.author_association",
});

// A draft marked ready by its author, whom the repo trusts.
export const readyForReview = on("pull_request", ["ready_for_review"], pullRequestNumber, {
  association: "pull_request.author_association",
});

// A review submitted by someone the repo trusts.
export const reviewSubmitted = on("pull_request_review", ["submitted"], pullRequestNumber, {
  association: "review.author_association",
});

// A pull request closed, merged among them: only someone with write access
// merges one, and the persona's own merge counts.
export const pullRequestClosed = on("pull_request", ["closed"], pullRequestNumber, {
  ownPersona: true,
});

// A pull request closed, which may have moved its base under every other open
// one, so no one item: the plan job looks at them all.
export const baseMoved = on("pull_request", ["closed"], { kind: "repo" }, { ownPersona: true });

// A CI run finished on a branch, the persona's own push's too. Filtered to the
// repo's CI workflows when the workflow is built.
export const ciCompleted = on(
  "workflow_run",
  ["completed"],
  { kind: "branch", path: "workflow_run.head_branch" },
  { ownPersona: true },
);

// A comment by someone the repo trusts.
export const commentCreated = on("issue_comment", ["created"], issueNumber, {
  association: "comment.author_association",
});

// What a flow declares: the events that wake it, and whether its sources read
// phases, so a phase event wakes it too.
export const FlowEvents = Schema.Struct({
  events: Schema.Array(WakingEvent),
  readsPhases: Schema.Boolean,
});

export type FlowEvents = typeof FlowEvents.Type;

// A flow, carrying what it declares. Not enumerable, so the flow's keys stay
// those it was defined with, as a compiled flow's plan is carried.
export const declare = <Declaring extends Flow>(flow: Declaring, declared: FlowEvents): Declaring =>
  Object.defineProperty(flow, "events", { value: declared, configurable: true });

const decodeFlowEvents = Schema.decodeUnknownOption(FlowEvents);

// What a flow declares, when it declares anything.
export const of = (flow: Flow): Option.Option<FlowEvents> => {
  if (!Predicate.hasProperty(flow, "events")) {
    return Option.none();
  }

  return decodeFlowEvents(flow.events);
};

// One of a repo's flows that runs in CI, as the plan job sees it: its name,
// the personas that run it, and what it declares.
export type CiFlow = {
  readonly flow: string;
  readonly personas: ReadonlyArray<string>;
  readonly declared: FlowEvents;
};

// What the workflow says of an event in its `on:` block.
export type EventFilter = {
  readonly types: ReadonlyArray<string>;
  readonly workflows?: ReadonlyArray<string>;
};

// Which flows an event of these types wakes, how its payload names the item,
// and the guards it keeps.
export type Route = {
  readonly event: string;
  readonly types: ReadonlyArray<string>;
  readonly flow: string;
  readonly personas: ReadonlyArray<string>;
  readonly item: ItemFrom;
  readonly association: Option.Option<string>;
  readonly trusted: boolean;
  readonly ownPersona: boolean;
};

export type Wiring = {
  // The workflow's `on:` block, by event, its keys in order.
  readonly on: { readonly [event: string]: EventFilter };
  // From each event to the flows and items it concerns.
  readonly routes: ReadonlyArray<Route>;
  // What was declared and left out, and why, for a person setting it up.
  readonly notes: ReadonlyArray<string>;
};

// The work item an event concerns, as its payload names it.
export type EventItem =
  | { readonly kind: "issue" | "pull-request"; readonly number: number }
  | { readonly kind: "branch" | "item"; readonly name: string }
  | { readonly kind: "repo" };

// A flow to run on an item, for a persona.
export type Woken = {
  readonly flow: string;
  readonly persona: string;
  readonly item: EventItem;
};

const sorted = (names: ReadonlyArray<string>) => Arr.sort(Arr.dedupe(names), Order.String);

// The route a phase event takes to a flow whose sources read phases: any
// writer's advance, the persona's own among them, since only someone with
// write access can send one.
const phaseRoute = (flow: CiFlow): Route => ({
  event: PHASE_EVENT,
  types: [PHASE_TYPE],
  flow: flow.flow,
  personas: flow.personas,
  item: { kind: "item", path: "client_payload.item" },
  association: Option.none(),
  trusted: false,
  ownPersona: true,
});

// The `on:` block a repo's workflow needs for the flows it runs in CI, and
// the map from each event to the flows and items it concerns. `ciWorkflows`
// names the repo's CI workflows, which `workflow_run` is filtered to; `own`
// names chernabog's own workflow, which is never among them, since every run
// of it that a newer one replaces completes cancelled and would wake another.
// The workflow's schedule, which sweeps for what an event missed, is the
// caller's to add.
export const workflowOn = (
  flows: ReadonlyArray<CiFlow>,
  options: { readonly ciWorkflows: ReadonlyArray<string>; readonly own?: string },
): Wiring => {
  const ownName = Option.fromUndefinedOr(options.own);

  const ciWorkflows = sorted(
    options.ciWorkflows.filter((name) => !Option.exists(ownName, (own) => own === name)),
  );

  const declared: ReadonlyArray<Route> = flows.flatMap((flow) =>
    flow.declared.events.map((waking): Route => ({
      event: waking.event,
      types: sorted(waking.types),
      flow: flow.flow,
      personas: flow.personas,
      item: waking.item,
      association: Option.fromUndefinedOr(waking.association),
      trusted: waking.trusted,
      ownPersona: waking.ownPersona,
    })),
  );

  const unfiltered = (route: Route) => route.event === "workflow_run" && ciWorkflows.length === 0;

  const routes = [
    ...declared.filter((route) => !unfiltered(route)),
    ...flows.flatMap((flow) =>
      Arr.filter([flow], (one) => one.declared.readsPhases).map(phaseRoute),
    ),
  ];

  const notes = sorted(
    declared.flatMap((route) => Arr.filter([route.flow], () => unfiltered(route))),
  ).map(
    (flow) =>
      `${flow} wakes on workflow_run, but the repo names no CI workflow to filter it to, so it waits for the schedule`,
  );

  const events = sorted(routes.map((route) => route.event));

  const filters = Object.fromEntries(
    events.map((event): readonly [string, EventFilter] => {
      const types = sorted(
        routes.filter((route) => route.event === event).flatMap((route) => route.types),
      );

      return [
        event,
        Option.match(
          Option.liftPredicate(ciWorkflows, () => event === "workflow_run"),
          {
            onNone: () => ({ types }),
            onSome: (workflows) => ({ workflows, types }),
          },
        ),
      ];
    }),
  );

  return { on: filters, routes, notes };
};

const asObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));

// The value at a dotted path into a payload.
const at = (payload: Json, path: string): Option.Option<Json> =>
  path
    .split(".")
    .reduce<Option.Option<Json>>(
      (found, key) =>
        Option.flatMap(found, (value) =>
          Option.flatMap(asObject(value), (object) => Record.get(object, key)),
        ),
      Option.some(payload),
    );

const numberAt = (payload: Json, path: string) =>
  Option.filter(at(payload, path), (value): value is number => Number.isInteger(value));

const nameAt = (payload: Json, path: string) =>
  Option.filter(
    at(payload, path),
    (value): value is string => Predicate.isString(value) && value.length > 0,
  );

const itemOf = (from: ItemFrom, payload: Json): Option.Option<EventItem> => {
  switch (from.kind) {
    case "repo":
      return Option.some({ kind: "repo" });
    case "issue":
    case "pull-request":
      return Option.map(numberAt(payload, from.path), (number) => ({ kind: from.kind, number }));
    case "branch":
    case "item":
      return Option.map(nameAt(payload, from.path), (name) => ({ kind: from.kind, name }));
  }
};

const trustedBy = (route: Route, payload: Json) =>
  !route.trusted ||
  Option.match(route.association, {
    onNone: () => true,
    onSome: (path) =>
      Option.exists(nameAt(payload, path), (association) =>
        TRUSTED.some((trusted) => trusted === association),
      ),
  });

const sameLogin = (one: string, other: string) => one.toLowerCase() === other.toLowerCase();

// The flows an event wakes, each for every persona that runs it, and the item
// its payload names: none when a guard refuses it, when no route takes its
// type, or when its payload doesn't name the item where its declaration says.
// `action` is the event's activity type, as a workflow reads it.
export const wokenBy = (
  routes: ReadonlyArray<Route>,
  event: string,
  payload: Json,
): ReadonlyArray<Woken> => {
  const action = nameAt(payload, "action");
  const sender = nameAt(payload, "sender.login");

  return routes
    .filter(
      (route) =>
        route.event === event &&
        Option.exists(action, (type) => route.types.includes(type)) &&
        trustedBy(route, payload),
    )
    .flatMap((route) =>
      Option.toArray(itemOf(route.item, payload)).flatMap((item) =>
        route.personas
          .filter(
            (persona) =>
              route.ownPersona || !Option.exists(sender, (login) => sameLogin(login, persona)),
          )
          .map((persona) => ({ flow: route.flow, persona, item })),
      ),
    );
};
