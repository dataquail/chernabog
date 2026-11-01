// The dashboard's main page: the daemon in the header, what needs a person,
// the filter, the runs and the repos, as the TUI's live view shows them.

import * as Option from "effect/Option";

import type { DaemonStatus } from "#daemon/protocol";

import { Attention } from "./attention.tsx";
import { DaemonStatusView } from "./daemon-status.tsx";
import { type Filter, filtered, personaChoices, repoChoices } from "./filter.ts";
import type { Connection, Live } from "./live.ts";
import { Repos } from "./repos.tsx";
import { Runs } from "./runs.tsx";

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

const choice = (value: string) => Option.liftPredicate(value, (chosen) => chosen !== "");

const Filters = ({
  filter,
  onFilter,
  status,
}: {
  readonly filter: Filter;
  readonly onFilter: (filter: Filter) => void;
  readonly status: DaemonStatus;
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
    <span className="muted keys">
      <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>enter</kbd> open · <kbd>/</kbd> filter
    </span>
  </form>
);

export const Overview = ({
  filter,
  live,
  now,
  onFilter,
  selected,
}: {
  readonly filter: Filter;
  readonly live: Live;
  readonly now: number;
  readonly onFilter: (filter: Filter) => void;
  // The run the keyboard selected, by its place in runOrder.
  readonly selected: Option.Option<number>;
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
    {Option.match(live.status, {
      onNone: () => <></>,
      onSome: (status) => {
        const shown = filtered(status, filter);

        return (
          <main>
            <Attention status={shown} now={now} />
            <Filters status={status} filter={filter} onFilter={onFilter} />
            <Runs status={shown} selected={selected} now={now} />
            <Repos repos={shown.repos} enrolled={status.repos.length > 0} now={now} />
          </main>
        );
      },
    })}
  </div>
);
