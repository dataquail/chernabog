// Where the URL's hash puts the page: one of the overview's tabs, a run, or
// one step of a run.
//
//   #/ or empty        the runs in flight (the page's home)
//   #/recent           the runs that ended lately
//   #/flows            every flow, on ones first
//   #/repos            each repo's own settings
//   #/runs/<id>        a run (a unique prefix of its id will do)
//   #/runs/<id>/steps/<step>   one step of it, and its log

import * as Option from "effect/Option";
import * as Result from "effect/Result";

export const TABS = ["active", "recent", "flows", "repos"] as const;

export type Tab = (typeof TABS)[number];

export type Route =
  | { readonly kind: "tab"; readonly tab: Tab }
  | { readonly kind: "run"; readonly runId: string; readonly step: Option.Option<string> };

const STEP_ROUTE = /^#\/runs\/([^/]+)\/steps\/(.+)$/;
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

// The route the hash names; anything it doesn't know is home.
export const routeOf = (hash: string): Route => {
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
