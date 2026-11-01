// The dashboard's main page: the daemon in the header, what needs a person,
// the filter, the runs and the repos, as the TUI's live view shows them.

import * as Option from "effect/Option";

import type { DaemonStatus } from "#daemon/protocol";

import { Attention } from "./attention.tsx";
import { DaemonStatusView } from "./daemon-status.tsx";
import { type Filter, filtered, personaChoices, repoChoices } from "./filter.ts";
import type { Connection, Live } from "./live.ts";
import { type Act, Repos } from "./repos.tsx";
import { Runs } from "./runs.tsx";
import { type Notice, offeredBy } from "./settings.ts";

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
  act,
  filter,
  live,
  notice,
  now,
  onFilter,
  selected,
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
            <Filters status={status} filter={filter} onFilter={onFilter} />
            <Runs status={shown} selected={selected} now={now} />
            <Repos
              act={act}
              repos={shown.repos}
              enrolled={status.repos.length > 0}
              offered={offeredBy(status)}
              now={now}
            />
          </main>
        );
      },
    })}
  </div>
);
