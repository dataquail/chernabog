// The dashboard's main page: the daemon in the header, what needs a person
// folded into one line, the tabs (the runs in flight, the ones that ended,
// the flows, the repos), the filter, and the tab the hash names.

import * as Option from "effect/Option";

import type { DaemonStatus } from "#daemon/protocol";

import { Attention } from "./attention.tsx";
import { DaemonStatusView } from "./daemon-status.tsx";
import { type Filter, filtered, personaChoices, repoChoices } from "./filter.ts";
import { Flows } from "./flows.tsx";
import type { Connection, Live } from "./live.ts";
import { type Act, Repos } from "./repos.tsx";
import { type Tab, tabHref, TABS } from "./routes.ts";
import { ActiveRuns, RecentRuns } from "./runs.tsx";
import { type Notice, offeredBy } from "./settings.ts";
import { shownIf } from "./show.tsx";

// The id of the filter `/` focuses.
export const FILTER_ID = "filter-repo";

const Banner = ({ connection }: { readonly connection: Connection }) => {
  switch (connection.kind) {
    case "live":
      return <></>;
    case "connecting":
      return (
        <p className="banner" role="status">
          Connecting to the daemon…
        </p>
      );
    case "reconnecting":
      return (
        <p className="banner" role="status">
          Reconnecting… ({connection.reason})
        </p>
      );
    case "stopped":
      return (
        <p className="banner stopped" role="alert">
          the dashboard was stopped; run <code>chernabog ui</code> to start it again
        </p>
      );
    case "refused":
      return (
        <p className="banner stopped" role="alert">
          {connection.message}
        </p>
      );
  }
};

// What the page says of the last setting a control sent.
const SettingNotice = ({ notice }: { readonly notice: Option.Option<Notice> }) =>
  Option.match(notice, {
    onNone: () => <></>,
    onSome: (said) => {
      if (said.kind === "problem") {
        return (
          <p className="banner stopped" role="alert">
            {said.text}
          </p>
        );
      }

      return (
        <p className="banner done" role="status">
          {said.text}
        </p>
      );
    },
  });

const choice = (value: string) => Option.liftPredicate(value, (chosen) => chosen !== "");

const TAB_NAME = {
  active: "Active",
  recent: "Recent",
  flows: "Flows",
  repos: "Repos",
} satisfies { readonly [T in Tab]: string };

// What a tab counts beside its name, as the filter leaves the status.
const counted = (tab: Tab, status: DaemonStatus) => {
  switch (tab) {
    case "active":
      return status.active.length;
    case "recent":
      return status.recent.length;
    case "flows":
      return status.repos.flatMap((repo) => repo.flows.filter((flow) => flow.enabled)).length;
    case "repos":
      return status.repos.length;
  }
};

const Tabs = ({ shown, tab }: { readonly shown: DaemonStatus; readonly tab: Tab }) => (
  <nav className="tabs" aria-label="Tabs">
    {TABS.map((each) => (
      <a
        key={each}
        href={tabHref(each)}
        aria-current={Option.getOrUndefined(
          Option.liftPredicate("page" as const, () => each === tab),
        )}
      >
        {TAB_NAME[each]} <span className="count">{counted(each, shown)}</span>
      </a>
    ))}
  </nav>
);

const listsRuns = (tab: Tab) => tab === "active" || tab === "recent";

const Filters = ({
  filter,
  onFilter,
  status,
  tab,
}: {
  readonly filter: Filter;
  readonly onFilter: (filter: Filter) => void;
  readonly status: DaemonStatus;
  readonly tab: Tab;
}) => (
  <form
    className="filters"
    role="search"
    onSubmit={(event) => {
      event.preventDefault();
    }}
  >
    <label>
      repo{" "}
      <select
        id={FILTER_ID}
        value={Option.getOrElse(filter.repo, () => "")}
        onChange={(event) => {
          onFilter({ ...filter, repo: choice(event.target.value) });
        }}
      >
        <option value="">all</option>
        {repoChoices(status).map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
    <label>
      persona{" "}
      <select
        value={Option.getOrElse(filter.persona, () => "")}
        onChange={(event) => {
          onFilter({ ...filter, persona: choice(event.target.value) });
        }}
      >
        <option value="">all</option>
        {personaChoices(status).map((login) => (
          <option key={login} value={login}>
            @{login}
          </option>
        ))}
      </select>
    </label>
    {shownIf(listsRuns(tab), () => (
      <span className="muted keys">
        <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>enter</kbd> open · <kbd>/</kbd> filter
      </span>
    ))}
  </form>
);

const TabBody = ({
  act,
  now,
  selected,
  shown,
  status,
  tab,
}: {
  readonly act: Act;
  readonly now: number;
  readonly selected: Option.Option<number>;
  // The status as the filter leaves it, and as the daemon sent it.
  readonly shown: DaemonStatus;
  readonly status: DaemonStatus;
  readonly tab: Tab;
}) => {
  switch (tab) {
    case "active":
      return <ActiveRuns status={shown} selected={selected} now={now} />;
    case "recent":
      return <RecentRuns status={shown} selected={selected} now={now} />;
    case "flows":
      return <Flows act={act} status={shown} now={now} />;
    case "repos":
      return (
        <Repos
          act={act}
          repos={shown.repos}
          enrolled={status.repos.length > 0}
          offered={offeredBy(status)}
        />
      );
  }
};

export const Overview = ({
  act,
  filter,
  live,
  notice,
  now,
  onFilter,
  selected,
  tab,
}: {
  // Where the repos' controls send what they change.
  readonly act: Act;
  readonly filter: Filter;
  readonly live: Live;
  // What the page says of the last setting a control sent.
  readonly notice: Option.Option<Notice>;
  readonly now: number;
  readonly onFilter: (filter: Filter) => void;
  // The run the keyboard selected, by its place in runOrder.
  readonly selected: Option.Option<number>;
  readonly tab: Tab;
}) => (
  <div className="page">
    <header>
      <h1>Chernabog</h1>
      {Option.match(live.status, {
        onNone: () => <></>,
        onSome: (status) => <DaemonStatusView status={status} />,
      })}
    </header>
    <Banner connection={live.connection} />
    <SettingNotice notice={notice} />
    {Option.match(live.status, {
      onNone: () => <></>,
      onSome: (status) => {
        const shown = filtered(status, filter);

        return (
          <main>
            <Attention status={shown} now={now} />
            <Tabs shown={shown} tab={tab} />
            <Filters status={status} filter={filter} onFilter={onFilter} tab={tab} />
            <TabBody
              act={act}
              now={now}
              selected={selected}
              shown={shown}
              status={status}
              tab={tab}
            />
          </main>
        );
      },
    })}
  </div>
);
