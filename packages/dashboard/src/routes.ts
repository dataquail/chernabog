// Where the URL's hash puts the page: one of the overview's tabs, a run, or
// one step of a run.
//
//   #/ or empty        the runs in flight (the page's home)
//   #/recent           the runs that ended lately
//   #/flows            every flow, on ones first
//   #/repos            each repo's own settings
//   #/runs/<id>        a run (a unique prefix of its id will do)
//   #/runs/<id>/steps/<step>   one step of it, and its log
//   #/runs/<id>/nodes/<node>[/rounds/<n>][/lanes/<lane>]
//                      one node of the plan the run is drawn on, in a round of
//                      its repeat and a lane of its forEach, and its steps' logs
//   #/runs/<id>/set-up, #/runs/<id>/wrap-up
//                      what the run did before its plan, or after it

import * as Option from "effect/Option";
import * as Result from "effect/Result";

export const TABS = ["active", "recent", "flows", "repos"] as const;

export type Tab = (typeof TABS)[number];

// A place on the plan a run is drawn on: a node in a round and a lane, each
// none outside one, or set up or wrap up, the steps before and after the plan.
export type NodePlace =
  | {
      readonly kind: "node";
      readonly id: string;
      readonly round: Option.Option<number>;
      readonly lane: Option.Option<string>;
    }
  | { readonly kind: "set-up" }
  | { readonly kind: "wrap-up" };

export type Route =
  | { readonly kind: "tab"; readonly tab: Tab }
  | { readonly kind: "run"; readonly runId: string; readonly step: Option.Option<string> }
  | { readonly kind: "node"; readonly runId: string; readonly place: NodePlace };

const STEP_ROUTE = /^#\/runs\/([^/]+)\/steps\/(.+)$/;
const NODE_ROUTE = /^#\/runs\/([^/]+)\/nodes\/([^/]+)(?:\/rounds\/(\d+))?(?:\/lanes\/([^/]+))?\/?$/;
const OFF_PLAN_ROUTE = /^#\/runs\/([^/]+)\/(set-up|wrap-up)\/?$/;
const RUN_ROUTE = /^#\/runs\/([^/]+)\/?$/;
const TAB_ROUTE = /^#\/([a-z]*)\/?$/;

const HOME: Route = { kind: "tab", tab: "active" };

const isTab = (name: string): name is Tab => TABS.some((tab) => tab === name);

// A hash part as the person typed or the page wrote it; one that isn't valid
// percent-encoding is taken as it is.
const decoded = (text: string) =>
  Result.getOrElse(
    Result.try(() => decodeURIComponent(text)),
    () => text,
  );

const groups = (pattern: RegExp, hash: string) =>
  Option.map(Option.fromNullishOr(pattern.exec(hash)), (found) => found.slice(1).map(decoded));

const offPlan = (name: string): NodePlace => {
  if (name === "set-up") {
    return { kind: "set-up" };
  }

  return { kind: "wrap-up" };
};

// A node's route, or set up's or wrap up's.
const nodeRoute = (hash: string): Option.Option<Route> => {
  const node = Option.map(Option.fromNullishOr(NODE_ROUTE.exec(hash)), (found): Route => ({
    kind: "node",
    runId: decoded(found[1]),
    place: {
      kind: "node",
      id: decoded(found[2]),
      round: Option.map(Option.fromUndefinedOr(found[3]), Number),
      lane: Option.map(Option.fromUndefinedOr(found[4]), decoded),
    },
  }));

  return Option.orElse(node, () =>
    Option.map(Option.fromNullishOr(OFF_PLAN_ROUTE.exec(hash)), (found): Route => ({
      kind: "node",
      runId: decoded(found[1]),
      place: offPlan(found[2]),
    })),
  );
};

// The route the hash names; anything it doesn't know is home.
export const routeOf = (hash: string): Route => {
  const onPlan = nodeRoute(hash);

  if (Option.isSome(onPlan)) {
    return onPlan.value;
  }

  const step = Option.flatMap(groups(STEP_ROUTE, hash), ([runId, name]) =>
    Option.all([Option.fromUndefinedOr(runId), Option.fromUndefinedOr(name)]),
  );

  if (Option.isSome(step)) {
    const [runId, name] = step.value;

    return { kind: "run", runId, step: Option.some(name) };
  }

  const run = Option.flatMap(groups(RUN_ROUTE, hash), ([runId]) => Option.fromUndefinedOr(runId));

  if (Option.isSome(run)) {
    return { kind: "run", runId: run.value, step: Option.none() };
  }

  const tab = Option.flatMap(groups(TAB_ROUTE, hash), ([name]) =>
    Option.filter(Option.fromUndefinedOr(name), isTab),
  );

  return Option.match(tab, {
    onNone: () => HOME,
    onSome: (named): Route => ({ kind: "tab", tab: named }),
  });
};

export const tabHref = (tab: Tab) => {
  if (tab === "active") {
    return "#/";
  }

  return `#/${tab}`;
};

export const runHref = (runId: string) => `#/runs/${encodeURIComponent(runId)}`;

export const stepHref = (runId: string, step: string) =>
  `${runHref(runId)}/steps/${encodeURIComponent(step)}`;

// Where a place on the plan a run is drawn on is shown.
export const nodeHref = (runId: string, place: NodePlace) => {
  switch (place.kind) {
    case "set-up":
    case "wrap-up":
      return `${runHref(runId)}/${place.kind}`;
    case "node":
      return [
        `${runHref(runId)}/nodes/${encodeURIComponent(place.id)}`,
        ...Option.toArray(Option.map(place.round, (round) => `/rounds/${round}`)),
        ...Option.toArray(Option.map(place.lane, (lane) => `/lanes/${encodeURIComponent(lane)}`)),
      ].join("");
  }
};
