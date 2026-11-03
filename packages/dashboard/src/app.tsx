// The page: the overview's tab, a run's detail or one step of it, as the
// URL's hash names (routes.ts), and the keyboard that moves between them.

import * as Option from "effect/Option";
import { useEffect, useState } from "react";

import { everything, type Filter, filtered } from "./filter.ts";
import { onKey, runOrder } from "./keys.ts";
import { FILTER_ID, Overview } from "./overview.tsx";
import { type Route, routeOf, runHref, type Tab } from "./routes.ts";
import { RunDetail } from "./run-detail.tsx";
import { useDaemon, useNow, useSettings } from "./use-daemon.ts";

// The tab the route shows, if it shows one.
const tabOf = (route: Route): Option.Option<Tab> => {
  if (route.kind === "tab") {
    return Option.some(route.tab);
  }

  return Option.none();
};

const useHash = () => {
  const [hash, setHash] = useState(location.hash);

  useEffect(() => {
    const changed = () => {
      setHash(location.hash);
    };

    window.addEventListener("hashchange", changed);

    return () => {
      window.removeEventListener("hashchange", changed);
    };
  }, []);

  return hash;
};

// Keys typed into a field are the field's.
const typing = (event: KeyboardEvent) =>
  event.target instanceof HTMLInputElement ||
  event.target instanceof HTMLSelectElement ||
  event.target instanceof HTMLTextAreaElement;

export const App = () => {
  const live = useDaemon(location.origin);
  const settings = useSettings(location.origin);
  const now = useNow();
  const hash = useHash();
  const [filter, setFilter] = useState<Filter>(everything);
  const [selected, setSelected] = useState<Option.Option<number>>(Option.none());

  const route = routeOf(hash);
  const tab = tabOf(route);

  const runs = Option.match(Option.all([live.status, tab]), {
    onNone: () => [],
    onSome: ([status, shown]) => runOrder(filtered(status, filter), shown),
  });

  // A selection is a place in one tab's list.
  const tabName = Option.getOrElse(tab, () => "");

  useEffect(() => {
    setSelected(Option.none());
  }, [tabName]);

  useEffect(() => {
    const pressed = (event: KeyboardEvent) => {
      if (Option.isNone(tab) || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (typing(event) && event.key !== "Escape") {
        return;
      }

      const action = onKey(event.key, runs, selected);

      switch (action.kind) {
        case "select":
          event.preventDefault();
          setSelected(Option.some(action.index));

          return;
        case "open":
          event.preventDefault();
          location.hash = runHref(action.runId);

          return;
        case "focus-filter":
          event.preventDefault();
          document.getElementById(FILTER_ID)?.focus();

          return;
        case "none":
          return;
      }
    };

    document.addEventListener("keydown", pressed);

    return () => {
      document.removeEventListener("keydown", pressed);
    };
  });

  if (route.kind === "run") {
    return <RunDetail runId={route.runId} now={now} status={live.status} />;
  }

  return (
    <Overview
      act={settings.act}
      notice={settings.notice}
      live={live}
      filter={filter}
      selected={selected}
      now={now}
      tab={route.tab}
      onFilter={(next) => {
        setFilter(next);
        setSelected(Option.none());
      }}
    />
  );
};
