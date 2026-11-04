// One run's page (#/runs/<id>, a unique prefix of the id will do): its row,
// the item it's on and the subjects it named, its summary, what it waits on,
// its steps as a graph (run-graph.ts), and its log as it grows, followed at its
// tail unless the person scrolls up. A step's page (#/runs/<id>/steps/<step>)
// is the run's, with that step marked in the graph, what's known of it, and
// that step's log alone in place of the run's.

import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { useEffect, useRef } from "react";

import type { DaemonStatus, RunHistory } from "#daemon/protocol";

import { runHref } from "./routes.ts";
import { type Detail } from "./run.ts";
import { laneLabel, type LaneNeeds, runGraph, type StepRecord, took } from "./run-graph.ts";
import { RunGraphView } from "./run-graph-view.tsx";
import { atBottom, initialLog, linesOfStep, type LogConnection, type LogState } from "./run-log.ts";
import { either, present, shownIf } from "./show.tsx";
import { span, When } from "./time.tsx";
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

// Where GitHub shows an item or subject a run names, by its key: `pr-12` and
// `issue-7` in the run's repo. Anything else is shown as it is.
const GITHUB_KEY = /^(pr|issue)-(\d+)$/;

export const githubUrl = (slug: Option.Option<string>, key: string) =>
  Option.flatMap(Option.fromNullishOr(GITHUB_KEY.exec(key)), (found) =>
    Option.map(slug, (repo) => {
      const kind = Option.match(
        Option.liftPredicate(found[1], (name) => name === "pr"),
        {
          onSome: () => "pull",
          onNone: () => "issues",
        },
      );

      return `https://github.com/${repo}/${kind}/${found[2]}`;
    }),
  );

const Linked = ({ href, text }: { readonly href: Option.Option<string>; readonly text: string }) =>
  Option.match(href, {
    onNone: () => <span>{text}</span>,
    onSome: (url) => <a href={url}>{text}</a>,
  });

// What the run named besides the item it's on.
const subjectsOf = (run: RunView) => run.subjects.filter((key) => key !== run.itemKey);

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
  const subjects = subjectsOf(run);

  return (
    <dl className="facts">
      <dt>Id</dt>
      <dd>
        <code>{run.id}</code>
      </dd>
      <dt>Item</dt>
      <dd>
        <Linked
          href={Option.orElse(run.itemUrl, () => githubUrl(slug, run.itemKey))}
          text={run.itemKey}
        />
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
      {shownIf(subjects.length > 0, () => (
        <>
          <dt>Subjects</dt>
          <dd className="subjects">
            {subjects.map((key) => (
              <Linked key={key} href={githubUrl(slug, key)} text={key} />
            ))}
          </dd>
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

// The steps as the graph takes them. A daemon from before steps' ends were
// kept sends neither end nor outcome.
const recordsOf = (history: RunHistory): ReadonlyArray<StepRecord> =>
  history.steps.map((entered) => ({
    step: entered.step,
    enteredAt: entered.enteredAt,
    finishedAt: Option.fromUndefinedOr(entered.finishedAt),
    outcome: Option.fromUndefinedOr(entered.outcome),
  }));

// Which lanes waited on which, as the run's flow declared it.
const lanesOf = (history: RunHistory): ReadonlyArray<LaneNeeds> => history.lanes ?? [];

// Whether the daemon keeps each line's step, as it says; one from before
// that says nothing.
const stepLogsOf = (history: RunHistory) => Option.fromUndefinedOr(history.stepLogs);

// The run's steps as the graph draws them.
export const graphOf = ({ history, run }: Found) =>
  runGraph(recordsOf(history), lanesOf(history), {
    running: run.status === "running",
    finishedAt: run.finishedAt,
  });

const Steps = ({
  chosen,
  found,
  now,
}: {
  readonly chosen: Option.Option<string>;
  readonly found: Found;
  readonly now: number;
}) => (
  <section aria-label="Steps">
    <h2>Steps</h2>
    {either(
      found.history.steps.length === 0,
      () => (
        <p className="muted">No steps were kept for this run.</p>
      ),
      () => (
        <RunGraphView chosen={chosen} graph={graphOf(found)} now={now} runId={found.run.id} />
      ),
    )}
  </section>
);

const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

// What's known of the step whose page this is.
const StepFacts = ({
  found,
  now,
  step,
}: {
  readonly found: Found;
  readonly now: number;
  readonly step: string;
}) => {
  const node = Option.fromUndefinedOr(
    graphOf(found)
      .lanes.flatMap((lane) => lane.steps)
      .find((each) => each.step === step),
  );

  return (
    <section aria-label="Step">
      <h2>
        {step}{" "}
        {present(node, (known) => (
          <span className={`badge ${known.state}`}>{known.state}</span>
        ))}
      </h2>
      {Option.match(node, {
        onNone: () => <p className="muted">This run has no step {step}.</p>,
        onSome: (known) => (
          <dl className="facts">
            <dt>Lane</dt>
            <dd>{laneLabel(known.lane)}</dd>
            <dt>Started</dt>
            <dd>
              <When iso={isoOf(known.startedAt)} now={now} />
            </dd>
            {present(known.endedAt, (ended) => (
              <>
                <dt>Ended</dt>
                <dd>
                  <When iso={isoOf(ended)} now={now} />
                </dd>
              </>
            ))}
            {present(took(known.startedAt, known.endedAt, known.state, now), (millis) => (
              <>
                <dt>Took</dt>
                <dd>{span(millis)}</dd>
              </>
            ))}
          </dl>
        ),
      })}
      <p>
        <a href={runHref(found.run.id)}>Back to the whole run</a>
      </p>
    </section>
  );
};

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

// How a step's page gets that step's log: the daemon follows only its lines
// (`server`), the page picks them out of the whole log (`page`), or neither
// can (`none`).
export type StepLogMode = "server" | "page" | "none";

// A daemon that tags each line with its step follows a step's lines itself,
// and says when an old log can be split only by its `step:` lines, or not at
// all. One from before that never says: the page splits the log of a run on
// one line itself, and can't split a run's whose lanes ran at once.
export const stepLogMode = (found: Found): StepLogMode =>
  Option.match(stepLogsOf(found.history), {
    onSome: (kept): StepLogMode => {
      if (kept === "unavailable") {
        return "none";
      }

      return "server";
    },
    onNone: (): StepLogMode => {
      if (graphOf(found).parallel) {
        return "none";
      }

      return "page";
    },
  });

// The log, kept at its tail as it grows while the person hasn't scrolled up.
export const LogView = ({
  log,
  title = "Log",
}: {
  readonly log: LogState;
  readonly title?: string;
}) => {
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
      <h2>{title}</h2>
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

// The log the page shows: the run's, or the step's whose page this is.
const Log = ({
  found,
  log,
  step,
}: {
  readonly found: Found;
  readonly log: LogState;
  readonly step: Option.Option<string>;
}) =>
  Option.match(step, {
    onNone: () => <LogView log={log} />,
    onSome: (name) => {
      if (stepLogMode(found) === "none") {
        return (
          <section aria-label="Log">
            <h2>Log of {name}</h2>
            <p className="muted">
              This run's steps ran at once and its log doesn't say which step wrote each line, so it
              can't be split by step. <a href={runHref(found.run.id)}>See the whole log</a>.
            </p>
          </section>
        );
      }

      return <LogView log={log} title={`Log of ${name}`} />;
    },
  });

const Body = ({
  asked,
  detail,
  log,
  now,
  slug,
  step,
}: {
  readonly asked: string;
  readonly detail: Detail;
  readonly log: LogState;
  readonly now: number;
  readonly slug: Option.Option<string>;
  readonly step: Option.Option<string>;
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
          <Steps chosen={step} found={detail} now={now} />
          {present(step, (name) => (
            <StepFacts found={detail} now={now} step={name} />
          ))}
          <Log found={detail} log={log} step={step} />
        </>
      );
  }
};

// The page, given what it holds: rendered as it is, for the tests. On a
// step's page, `log` is that step's lines alone.
export const RunDetailView = ({
  step = Option.none(),
  ...props
}: {
  readonly asked: string;
  readonly detail: Detail;
  readonly log: LogState;
  readonly now: number;
  readonly slug: Option.Option<string>;
  readonly step?: Option.Option<string>;
}) => (
  <div className="page">
    <header>
      <h1>Chernabog</h1>
      <a href="#/">Back to the overview</a>
    </header>
    <main>
      <Body {...props} step={step} />
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
  step,
}: {
  readonly asked: string;
  readonly found: Found;
  readonly now: number;
  readonly status: Option.Option<DaemonStatus>;
  readonly step: Option.Option<string>;
}) => {
  const mode = Option.map(step, () => stepLogMode(found));

  // Only a daemon that keeps each line's step is asked for one step's lines.
  const followed = Option.filter(step, () => Option.contains(mode, "server"));
  const log = useRunLog(location.origin, found.run.id, followed);

  const shown = Option.match(
    Option.filter(step, () => Option.contains(mode, "page")),
    {
      onNone: () => log,
      onSome: (name) => ({ ...log, lines: linesOfStep(log.lines, name) }),
    },
  );

  return (
    <RunDetailView
      asked={asked}
      detail={found}
      log={shown}
      now={now}
      slug={slugOf(status, found.run.repo)}
      step={step}
    />
  );
};

export const RunDetail = ({
  now,
  runId,
  status,
  step,
}: {
  readonly runId: string;
  readonly now: number;
  readonly status: Option.Option<DaemonStatus>;
  readonly step: Option.Option<string>;
}) => {
  const detail = useRunDetail(location.origin, runId);

  if (detail.kind === "found") {
    return <FoundRun asked={runId} found={detail} now={now} status={status} step={step} />;
  }

  return (
    <RunDetailView
      asked={runId}
      detail={detail}
      log={initialLog}
      now={now}
      slug={Option.none()}
      step={step}
    />
  );
};
