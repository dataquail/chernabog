// The page: the overview, or a run's detail when the URL's hash names one
// (#/runs/<id>), and the keyboard that moves between them.

import * as Option from "effect/Option";
import { useEffect, useState } from "react";

import { everything, type Filter, filtered } from "./filter.ts";
import { onKey, runOrder } from "./keys.ts";
import { FILTER_ID, Overview } from "./overview.tsx";
import { RunDetail } from "./run-detail.tsx";
import { runHref } from "./runs.tsx";
import { useDaemon, useNow, useSettings } from "./use-daemon.ts";

const RUN_ROUTE = /^#\/runs\/(.+)$/;

// The run the hash names, if it names one.
const routedRun = (hash: string) =>
  Option.map(Option.fromNullishOr(RUN_ROUTE.exec(hash)?.[1]), decodeURIComponent);

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

  const runs = Option.match(live.status, {
    onNone: () => [],
    onSome: (status) => runOrder(filtered(status, filter)),
  });

  const route = routedRun(hash);

  useEffect(() => {
    const pressed = (event: KeyboardEvent) => {
      if (Option.isSome(route) || event.metaKey || event.ctrlKey || event.altKey) {
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

  return Option.match(route, {
    onSome: (runId) => <RunDetail runId={runId} now={now} status={live.status} />,
    onNone: () => (
      <Overview
        act={settings.act}
        notice={settings.notice}
        live={live}
        filter={filter}
        selected={selected}
        now={now}
        onFilter={(next) => {
          setFilter(next);
          setSelected(Option.none());
        }}
      />
    ),
  });
};
