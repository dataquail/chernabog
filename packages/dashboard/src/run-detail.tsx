// One run's page (#/runs/<id>, a unique prefix of the id will do): its row,
// its pull request, subjects and summary, what it waits on, the steps it went
// through, and its log as it grows, followed at its tail unless the person
// scrolls up.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { useEffect, useRef } from "react";

import type { DaemonStatus } from "#daemon/protocol";

import { type Detail } from "./run.ts";
import { atBottom, initialLog, type LogConnection, type LogState } from "./run-log.ts";
import { either, present, shownIf } from "./show.tsx";
import { When } from "./time.tsx";
import { useRunDetail, useRunLog } from "./use-run.ts";

type Found = Extract<Detail, { readonly kind: "found" }>;

type RunView = Found["run"];

// The id of the log's element, which the page keeps scrolled to its tail.
const LOG_ID = "run-log";

// What a run is, for people, since its id doesn't say: api/implement issue-7 as bob.
const label = (run: RunView) =>
  `${run.repo}/${run.flow} ${run.itemKey}${Option.match(run.persona, {
    onNone: () => "",
    onSome: (login) => ` as ${login}`,
  })}`;

// A running run parked on a signal shows as parked.
const state = ({ history, run }: Found) =>
  Option.getOrElse(
    Option.liftPredicate("parked", () => run.status === "running" && history.waits.length > 0),
    () => run.status,
  );

const PULL_REQUEST = /^pr-(\d+)/;

// The pull requests a run is part of: its own item, if it is one, and each it
// opened, named as its subjects.
const pullRequests = (run: RunView) =>
  Arr.dedupe(
    [run.itemKey, ...run.subjects].flatMap((key) =>
      Option.toArray(Option.fromNullishOr(PULL_REQUEST.exec(key)?.[1])),
    ),
  );

const PullRequest = ({
  number,
  slug,
}: {
  readonly number: string;
  readonly slug: Option.Option<string>;
}) =>
  Option.match(slug, {
    onNone: () => <span>#{number}</span>,
    onSome: (repo) => <a href={`https://github.com/${repo}/pull/${number}`}>#{number}</a>,
  });

const Facts = ({
  found,
  now,
  slug,
}: {
  readonly found: Found;
  readonly now: number;
  readonly slug: Option.Option<string>;
}) => {
  const { run } = found;
  const numbers = pullRequests(run);

  return (
    <dl className="facts">
      <dt>Id</dt>
      <dd>
        <code>{run.id}</code>
      </dd>
      <dt>Item</dt>
      <dd>
        {Option.match(run.itemUrl, {
          onNone: () => <span>{run.itemKey}</span>,
          onSome: (url) => <a href={url}>{run.itemKey}</a>,
        })}
      </dd>
      {present(run.currentStep, (step) => (
        <>
          <dt>Step</dt>
          <dd>{step}</dd>
        </>
      ))}
      <dt>Started</dt>
      <dd>
        <When iso={run.startedAt} now={now} />
      </dd>
      {present(run.finishedAt, (iso) => (
        <>
          <dt>Finished</dt>
          <dd>
            <When iso={iso} now={now} />
          </dd>
        </>
      ))}
      {shownIf(numbers.length > 0, () => (
        <>
          <dt>Pull request</dt>
          <dd>
            {numbers.map((number) => (
              <PullRequest key={number} number={number} slug={slug} />
            ))}
          </dd>
        </>
      ))}
      {shownIf(run.subjects.length > 0, () => (
        <>
          <dt>Subjects</dt>
          <dd>{run.subjects.join(", ")}</dd>
        </>
      ))}
      {present(run.summary, (summary) => (
        <>
          <dt>Summary</dt>
          <dd>{summary}</dd>
        </>
      ))}
    </dl>
  );
};

const Waits = ({ found, now }: { readonly found: Found; readonly now: number }) =>
  shownIf(found.history.waits.length > 0, () => (
    <section aria-label="Waits">
      <h2>Waiting on</h2>
      <ul>
        {found.history.waits.map((wait) => (
          <li key={wait.deferred}>
            {wait.signal} <code>{wait.deferred}</code>
            {present(wait.parkedAt, (iso) => (
              <>
                {" "}
                since <When iso={iso} now={now} />
              </>
            ))}
          </li>
        ))}
      </ul>
    </section>
  ));

const Steps = ({ found, now }: { readonly found: Found; readonly now: number }) => (
  <section aria-label="Steps">
    <h2>Steps</h2>
    {either(
      found.history.steps.length === 0,
      () => (
        <p className="muted">No steps were kept for this run.</p>
      ),
      () => (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Step</th>
                <th>Entered</th>
              </tr>
            </thead>
            <tbody>
              {found.history.steps.map((step) => (
                <tr key={`${step.step} ${step.enteredAt}`}>
                  <td>{step.step}</td>
                  <td>
                    <When iso={step.enteredAt} now={now} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ),
    )}
  </section>
);

const LogStatus = ({ connection }: { readonly connection: LogConnection }) => {
  switch (connection.kind) {
    case "connecting":
      return <p className="muted">Connecting to the log…</p>;
    case "live":
      return <></>;
    case "reconnecting":
      return (
        <p className="banner" role="status">
          The log's stream dropped; reconnecting…
        </p>
      );
    case "ended":
      return <p className="muted">The log is complete.</p>;
  }
};

// The log, kept at its tail as it grows while the person hasn't scrolled up.
export const LogView = ({ log }: { readonly log: LogState }) => {
  const following = useRef(true);

  useEffect(() => {
    for (const box of Option.toArray(Option.fromNullishOr(document.getElementById(LOG_ID)))) {
      if (following.current) {
        box.scrollTop = box.scrollHeight;
      }
    }
  }, [log.lines]);

  return (
    <section aria-label="Log">
      <h2>Log</h2>
      <pre
        id={LOG_ID}
        className="log"
        onScroll={(event) => {
          following.current = atBottom(event.currentTarget);
        }}
      >
        {log.lines.join("\n")}
      </pre>
      <LogStatus connection={log.connection} />
    </section>
  );
};

const Body = ({
  asked,
  detail,
  log,
  now,
  slug,
}: {
  readonly asked: string;
  readonly detail: Detail;
  readonly log: LogState;
  readonly now: number;
  readonly slug: Option.Option<string>;
}) => {
  switch (detail.kind) {
    case "loading":
      return <p className="muted">Loading the run…</p>;
    case "unknown":
      return <p>{`No run ${asked}.`}</p>;
    case "refused":
      return (
        <p className="banner stopped" role="alert">
          {detail.message}
        </p>
      );
    case "found":
      return (
        <>
          <section aria-label="Run">
            <h2>
              {label(detail.run)}
              <span className={`badge ${state(detail)}`}>{state(detail)}</span>
            </h2>
            {present(detail.run.itemTitle, (title) => (
              <p className="muted">{title}</p>
            ))}
            <Facts found={detail} now={now} slug={slug} />
          </section>
          <Waits found={detail} now={now} />
          <Steps found={detail} now={now} />
          <LogView log={log} />
        </>
      );
  }
};

// The page, given what it holds: rendered as it is, for the tests.
export const RunDetailView = (props: {
  readonly asked: string;
  readonly detail: Detail;
  readonly log: LogState;
  readonly now: number;
  readonly slug: Option.Option<string>;
}) => (
  <div className="page">
    <header>
      <h1>Chernabog</h1>
      <a href="#/">Back to the overview</a>
    </header>
    <main>
      <Body {...props} />
    </main>
  </div>
);

// The repo's GitHub slug, from the status the overview follows.
const slugOf = (status: Option.Option<DaemonStatus>, repo: string) =>
  Option.flatMap(status, (found) =>
    Option.map(
      Arr.findFirst(found.repos, (candidate) => candidate.name === repo),
      (candidate) => candidate.slug,
    ),
  );

const FoundRun = ({
  asked,
  found,
  now,
  status,
}: {
  readonly asked: string;
  readonly found: Found;
  readonly now: number;
  readonly status: Option.Option<DaemonStatus>;
}) => {
  const log = useRunLog(location.origin, found.run.id);

  return (
    <RunDetailView
      asked={asked}
      detail={found}
      log={log}
      now={now}
      slug={slugOf(status, found.run.repo)}
    />
  );
};

export const RunDetail = ({
  now,
  runId,
  status,
}: {
  readonly runId: string;
  readonly now: number;
  readonly status: Option.Option<DaemonStatus>;
}) => {
  const detail = useRunDetail(location.origin, runId);

  if (detail.kind === "found") {
    return <FoundRun asked={runId} found={detail} now={now} status={status} />;
  }

  return (
    <RunDetailView asked={runId} detail={detail} log={initialLog} now={now} slug={Option.none()} />
  );
};
