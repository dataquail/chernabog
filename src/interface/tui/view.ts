// What the TUI shows, as plain lines of styled segments: the view is a pure
// function of the model, so it can be tested without a terminal.

import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import { type Persona, samePersona } from "../../kernel/persona.value-object.ts";
import { FLOW_TURNED_OFF } from "../../modules/enrollment/enrollment.platform.ts";
import {
  ActiveRun,
  type FlowPlan,
  type LoggedAt,
  type RunHistory,
} from "../../modules/runs/runs.platform.ts";
import {
  type DaemonStatus,
  type NodeOnPlan,
  type NodeState,
  type OffPlan,
  type PersonaStatus,
  type RepoStatus,
  RunOnPlan,
} from "../daemon/daemon.protocol.ts";

export type Style =
  "plain" | "bold" | "dim" | "green" | "red" | "yellow" | "cyan" | "magenta" | "selected";

export type Segment = { readonly text: string; readonly style: Style };

export type Line = ReadonlyArray<Segment>;

export type UsageRow = {
  readonly account: string;
  readonly fiveHour: number;
  readonly sevenDay: number;
  readonly launch: boolean;
  readonly reason: string;
  readonly at: string;
};

// A flow as one persona runs it; none for the implicit persona.
export type FlowRow = {
  readonly repo: string;
  readonly flow: string;
  readonly persona: Option.Option<string>;
};

export type RunEntry = ActiveRun;

type RunStatus = ActiveRun["status"];

// A line of a persona's settings: one of its flows, its account, or a role's.
export type SettingsRow =
  | { readonly kind: "flow"; readonly flow: string }
  | { readonly kind: "account" }
  | { readonly kind: "role"; readonly role: string };

// What the settings view is doing: browsing its rows, typing a flow's
// schedule, or choosing an account for the persona or one of its roles.
export type Editing =
  | { readonly kind: "browse" }
  | { readonly kind: "cron"; readonly flow: string; readonly text: string }
  | {
      readonly kind: "pick";
      readonly role: Option.Option<string>;
      readonly choices: ReadonlyArray<string>;
      readonly index: number;
    };

// The settings of one persona of one repo, as the settings view shows them.
export type Settings = {
  readonly repo: string;
  readonly persona: Option.Option<string>;
  readonly index: number;
  readonly editing: Editing;
};

export type Model = {
  readonly status: Option.Option<DaemonStatus>;
  readonly error: Option.Option<string>;
  // The /events stream dropped; the view shows what it last knew until it is back.
  readonly reconnecting: boolean;
  readonly usage: ReadonlyArray<UsageRow>;
  readonly thresholds: { readonly fiveHourCeiling: number; readonly targetEndUsage: number };
  // The project tab (a repo's name; none for All) and the persona filter
  // (none for all), which flows, runs and skips are shown through.
  readonly project: Option.Option<string>;
  readonly personaFilter: Option.Option<Persona>;
  readonly focus: "flows" | "runs";
  readonly flowIndex: number;
  readonly runIndex: number;
  // The threads opened in the runs list to show all their runs, by threadOf.
  readonly expanded: ReadonlyArray<string>;
  // The selected line of the detail view: a node of the run's plan, then a
  // run of its thread.
  readonly detailIndex: number;
  readonly view: "main" | "log" | "settings" | "run";
  readonly settings: Option.Option<Settings>;
  // The run the detail view shows, where it has been, once the daemon has
  // said, and the worktree its latest agent session ran in.
  readonly detailRun: Option.Option<string>;
  readonly history: Option.Option<RunHistory>;
  // The plan the run started with, for a run of a flow that has one.
  readonly plan: Option.Option<FlowPlan>;
  // The lanes of a forEach opened to show their steps, and the round each
  // repeat shows when not its latest, by the node's key (detailTargets).
  readonly unfolded: ReadonlyArray<string>;
  readonly rounds: Readonly<Record<string, number>>;
  readonly worktree: Option.Option<string>;
  readonly logRun: Option.Option<string>;
  // The node of the plan whose log the log view shows, by its name and the
  // steps it ran; none for the whole log.
  readonly logOf: Option.Option<NodeLog>;
  readonly logLines: ReadonlyArray<string>;
  // Lines up from the bottom of the log; 0 follows it as it grows.
  readonly logScroll: number;
  readonly message: Option.Option<string>;
  // The run in flight a person asked to cancel, until they confirm it or not.
  readonly cancelling: Option.Option<RunEntry>;
  // Flows turned on or off from here that the daemon hasn't restarted on yet, by flowKey.
  readonly pendingFlows: Readonly<Record<string, boolean>>;
  readonly width: number;
  readonly height: number;
  readonly now: DateTime.Utc;
};

// The node of the plan whose log the log view shows: by its key, so its
// steps are worked out again from the run's history as the run enters them,
// its name, and the steps it had when opened, for when it is no longer drawn.
export type NodeLog = {
  readonly key: string;
  readonly name: string;
  readonly only: ReadonlyArray<LoggedAt>;
};

// A line of the plan's tree a person can select: its key, which stays the
// same as the run goes on, its name, the steps whose log enter opens, the
// lanes space opens or closes, and for a repeat its key and how many rounds
// it has.
export type DetailTarget = {
  readonly key: string;
  readonly label: string;
  readonly only: ReadonlyArray<LoggedAt>;
  readonly lanes: ReadonlyArray<string>;
  readonly repeat: Option.Option<{ readonly key: string; readonly rounds: number }>;
};

const segment = (text: string, style: Style = "plain"): Segment => ({ text, style });

export const flowKey = (repo: string, flow: string, persona: Option.Option<string>) =>
  `${repo}/${flow}${Option.match(persona, { onNone: () => "", onSome: (login) => `@${login}` })}`;

// Whether a persona runs a flow: as turned from here, else as the daemon has
// it. Each persona turns its flows on and off for itself.
export const flowEnabled = (
  model: Model,
  repo: string,
  flow: { readonly name: string; readonly enabled: boolean; readonly persona?: string },
) =>
  Option.getOrElse(
    Record.get(model.pendingFlows, flowKey(repo, flow.name, Option.fromUndefinedOr(flow.persona))),
    () => flow.enabled,
  );

const onlyIf = <A>(condition: boolean, items: ReadonlyArray<A>): ReadonlyArray<A> => {
  if (condition) {
    return items;
  }

  return [];
};

const styleIf = (condition: boolean, style: Style): Style => {
  if (condition) {
    return style;
  }

  return "plain";
};

// The projects a tab picks from: every repo the daemon has, in its order.
export const projectsOf = (status: Option.Option<DaemonStatus>): ReadonlyArray<string> =>
  Option.match(status, {
    onNone: () => [],
    onSome: (found) => found.repos.map((repo) => repo.name),
  });

// The personas the filter picks from: every one a flow runs as, or a run ran
// as, in the order first seen.
export const personasOf = (status: Option.Option<DaemonStatus>): ReadonlyArray<Persona> =>
  Option.match(status, {
    onNone: () => [],
    onSome: (found) =>
      Arr.dedupeWith(
        [
          ...found.repos.flatMap((repo) =>
            repo.flows.map((flow) => Option.fromUndefinedOr(flow.persona)),
          ),
          ...found.active.map((run) => run.persona),
          ...found.recent.map((run) => run.persona),
        ],
        samePersona,
      ),
  });

// Whether a repo and persona pass the project tab and the persona filter.
const passes = (model: Model, repo: string, persona: Persona) =>
  Option.match(model.project, { onNone: () => true, onSome: (name) => name === repo }) &&
  Option.match(model.personaFilter, {
    onNone: () => true,
    onSome: (chosen) => samePersona(chosen, persona),
  });

// Which run columns show: one a filter fixes, or that has one value to show, is dropped.
export const shownColumns = (model: Model): Shown => ({
  repo: Option.isNone(model.project) && projectsOf(model.status).length > 1,
  persona: Option.isNone(model.personaFilter) && personasOf(model.status).length > 1,
});

export const flowRows = (model: Model): ReadonlyArray<FlowRow> =>
  Option.match(model.status, {
    onNone: () => [],
    onSome: (found) =>
      found.repos.flatMap((repo) =>
        repo.flows
          .map((flow): FlowRow => ({
            repo: repo.name,
            flow: flow.name,
            persona: Option.fromUndefinedOr(flow.persona),
          }))
          .filter((row) => passes(model, row.repo, row.persona)),
      ),
  });

const MAX_RUNS = 15;

// Every run the daemon reported: runs in flight first, then the latest finished ones.
export const allRuns = (status: Option.Option<DaemonStatus>): ReadonlyArray<RunEntry> =>
  Option.match(status, {
    onNone: () => [],
    onSome: (found) => [
      ...found.active,
      ...found.recent
        .filter((run) => run.status !== "running")
        .map((run) => ActiveRun.make({ ...run, parked: false })),
    ],
  });

const MINUTE = 60;
const HOUR = 3600;

const spanText = (span: number) => {
  if (span < MINUTE) {
    return `${span}s`;
  }

  if (span < HOUR) {
    return `${Math.round(span / MINUTE)}m`;
  }

  return `${Math.round(span / HOUR)}h`;
};

const ago = (at: Option.Option<string>, now: DateTime.Utc) =>
  Option.match(
    Option.flatMap(at, (iso) => DateTime.make(iso)),
    {
      onNone: () => "—",
      onSome: (then) => {
        const seconds = Math.round(
          (DateTime.toEpochMillis(then) - DateTime.toEpochMillis(now)) / 1000,
        );

        const span = Math.abs(seconds);

        if (span < 1) {
          return "now";
        }

        if (seconds > 0) {
          return `in ${spanText(span)}`;
        }

        return `${spanText(span)} ago`;
      },
    },
  );

const pad = (text: string, width: number) => {
  if (text.length >= width) {
    return `${text.slice(0, Math.max(0, width - 1))}…`;
  }

  return text.padEnd(width);
};

const percent = (value: number) => `${Math.round(value * 100)}%`.padStart(4);

const firstLine = (text: string) => text.split("\n")[0] ?? "";

const STATUS_STYLE: Readonly<Record<RunStatus, Style>> = {
  done: "green",
  running: "cyan",
  skipped: "dim",
  "needs-human": "yellow",
  cancelled: "dim",
  superseded: "dim",
  lost: "yellow",
  failed: "red",
};

const heading = (text: string): Line => [segment(text, "bold")];

const select = (line: Line, selected: boolean): Line => {
  if (!selected) {
    return line;
  }

  return line.map((part) => ({ ...part, style: "selected" }));
};

export const KEYS_MAIN =
  "tab switch pane · ↑↓ select · enter run or settings · space open thread · 0-9 [ ] project · @ persona · a attach · x cancel run · t trigger · e flow on/off · p pause/resume · r refresh · q quit";

export const KEYS_LOG = "↑↓ scroll · end follow · a attach · esc back · q quit";

export const KEYS_RUN =
  "↑↓ select · enter its log or run · space lanes · [ ] rounds · l log · a attach · x cancel run · esc back · q quit";

export const KEYS_SETTINGS =
  "↑↓ select · e flow on/off · s schedule · enter choose account · c clear override · esc back · q quit";

export const KEYS_CRON = "type a cron, such as */20 * * * * · enter save · esc cancel";
export const KEYS_PICK = "↑↓ select · enter save · esc cancel";

const repoState = (repo: RepoStatus) => {
  if (repo.paused) {
    return "paused";
  }

  if (!repo.enabled) {
    return "disabled";
  }

  return repo.status;
};

const stateStyle = (state: string): Style => {
  if (state === "ready") {
    return "green";
  }

  if (state === "paused" || state === "disabled") {
    return "yellow";
  }

  return "red";
};

const QUEUE_SHOWN = 3;

const queuedText = (queued: ReadonlyArray<string>) => {
  if (queued.length === 0) {
    return "queue empty";
  }

  const more = onlyIf(queued.length > QUEUE_SHOWN, ["…"]);

  return `${queued.length} queued: ${[...queued.slice(0, QUEUE_SHOWN), ...more].join(", ")}`;
};

const queueText = (queued: ReadonlyArray<string>, elsewhere: ReadonlyArray<string>) => {
  if (elsewhere.length === 0) {
    return queuedText(queued);
  }

  return `${queuedText(queued)} · ${elsewhere.length} left for others`;
};

const plural = (count: number) => {
  if (count === 1) {
    return "";
  }

  return "s";
};

// A step's name as a person reads it: an activity named for its comment or
// commit carries a hash (`comment-pr-124-619c4991c631`), which says nothing
// here. Stored names stay as they are, since they're journal keys.
const STEP_HASH = /-(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}$/;

export const tidyStep = (step: string) => step.replace(STEP_HASH, "");

const runDetail = (run: RunEntry) => {
  if (run.status !== "running") {
    return Option.getOrElse(run.summary, () => "");
  }

  if (run.parked) {
    return Option.match(run.currentStep, {
      onNone: () => "waiting for a signal",
      onSome: (step) => `waiting in ${tidyStep(step)}`,
    });
  }

  return Option.getOrElse(run.currentStep, () => "starting");
};

// When a flow next ticks: due now while an event's tick waits to run (#138).
const nextTickOf = (
  flow: { readonly next: Option.Option<string>; readonly pending?: string },
  now: DateTime.Utc,
) =>
  Option.match(Option.fromUndefinedOr(flow.pending), {
    onNone: () => ago(flow.next, now),
    onSome: () => "due now",
  });

const flowTiming = (enabled: boolean, pending: boolean, next: string) => {
  if (pending && enabled) {
    return segment(pad("on, pending", 14), "yellow");
  }

  if (pending) {
    return segment(pad("off, pending", 14), "yellow");
  }

  if (enabled) {
    return segment(`next ${pad(next, 9)}`);
  }

  return segment(pad("off", 14), "dim");
};

const launchSegment = (launch: boolean, when: string) => {
  if (launch) {
    return segment(`  room for a task (${when})`, "dim");
  }

  return segment(`  holding back (${when})`, "yellow");
};

const detailStyle = (status: RunStatus): Style => {
  if (status === "running") {
    return "cyan";
  }

  return "dim";
};

// What a run is about, from its item key: a pull request (`pr-124`, and keys
// with a suffix such as `pr-124-changes-1`), an issue (`issue-144`), or the
// key itself for any other item.
export type ItemRef =
  | { readonly kind: "pr"; readonly number: number }
  | { readonly kind: "issue"; readonly number: number }
  | { readonly kind: "other"; readonly key: string };

const ITEM_KEY = /^(pr|issue)-(\d+)(?:-|$)/;

export const itemRef = (itemKey: string): ItemRef =>
  Option.match(Option.fromNullishOr(ITEM_KEY.exec(itemKey)), {
    onNone: (): ItemRef => ({ kind: "other", key: itemKey }),
    onSome: (match): ItemRef => {
      const number = Number(match[2]);

      if (match[1] === "pr") {
        return { kind: "pr", number };
      }

      return { kind: "issue", number };
    },
  });

const itemText = (ref: ItemRef) => {
  if (ref.kind === "pr") {
    return `PR ${ref.number}`;
  }

  if (ref.kind === "issue") {
    return `#${ref.number}`;
  }

  return ref.key;
};

const ITEM_STYLE: Readonly<Record<ItemRef["kind"], Style>> = {
  pr: "magenta",
  issue: "cyan",
  other: "plain",
};

// A row of the runs list: the latest run of a piece of work, with how many
// others it has, or, under it while its thread is open, one of those others.
export type RunRow = {
  readonly run: RunEntry;
  readonly thread: string;
  readonly lead: boolean;
  readonly others: number;
  readonly expanded: boolean;
};

// A work item's key as a thread names it: `pr-<n>` for any key on a pull
// request (`pr-124-changes-1` too), `issue-<n>` for an issue, else the key.
const workKey = (key: string) => {
  const ref = itemRef(key);

  if (ref.kind === "pr") {
    return `pr-${ref.number}`;
  }

  if (ref.kind === "issue") {
    return `issue-${ref.number}`;
  }

  return ref.key;
};

// The work items a run is part of: its own, then each subject it named.
const workKeysOf = (run: RunEntry) =>
  [run.itemKey, ...run.subjects].map((key) => `${run.repo} ${workKey(key)}`);

// The piece of work each run is part of: runs that share a work item, as
// their own or as a subject, directly or through other runs, are one thread,
// named by the least of its work items' keys. So an issue's run that
// opened two pull requests threads with the runs on both, and one that
// released `release-1.4` with the runs on that.
const threadsOf = (runs: ReadonlyArray<RunEntry>) => {
  const parent = new Map<string, string>();

  const root = (key: string): string => {
    const above = parent.get(key) ?? key;

    if (above === key) {
      return key;
    }

    const found = root(above);
    parent.set(key, found);

    return found;
  };

  for (const run of runs) {
    const [own, ...others] = workKeysOf(run);

    for (const other of others) {
      const [first, second] = [root(own), root(other)].toSorted();
      parent.set(second, first);
    }
  }

  return (run: RunEntry) => root(workKeysOf(run)[0]);
};

// Runs grouped by the piece of work they're part of, each latest first, in
// the order of their latest runs.
const threads = (runs: ReadonlyArray<RunEntry>, threadOf: (run: RunEntry) => string) => {
  const grouped = new Map<string, Array<RunEntry>>();

  for (const run of runs) {
    const thread = threadOf(run);
    grouped.set(thread, [...(grouped.get(thread) ?? []), run]);
  }

  return [...grouped];
};

// The runs list: a row per piece of work through the filters, and the other
// runs of each thread that's open under it.
export const runRows = (model: Model): ReadonlyArray<RunRow> => {
  const all = allRuns(model.status);
  const shown = all.filter((run) => passes(model, run.repo, run.persona));

  return threads(shown, threadsOf(all))
    .slice(0, MAX_RUNS)
    .flatMap(([thread, runs]) => {
      const expanded = model.expanded.includes(thread);

      return runs
        .filter((_, index) => index === 0 || expanded)
        .map((run, index): RunRow => ({
          run,
          thread,
          lead: index === 0,
          others: runs.length - 1,
          expanded,
        }));
    });
};

// The other runs of the piece of work `runId` is part of, latest first.
export const threadRuns = (model: Model, runId: string): ReadonlyArray<RunEntry> => {
  const all = allRuns(model.status);
  const threadOf = threadsOf(all);

  return Option.match(
    Arr.findFirst(all, (run) => run.id === runId),
    {
      onNone: () => [],
      onSome: (found) => {
        const thread = threadOf(found);

        return all.filter((run) => run.id !== runId && threadOf(run) === thread);
      },
    },
  );
};

const personaText = (persona: Option.Option<string>) =>
  Option.match(persona, { onNone: () => "", onSome: (login) => `@${login}` });

// Which of a run row's columns show: a filter that fixes the repo or the
// persona drops its column.
export type Shown = { readonly repo: boolean; readonly persona: boolean };

// The widths of a run row's columns, for the runs shown and the terminal's
// width; 0 for a column that isn't shown.
type RunColumns = {
  readonly item: number;
  readonly flow: number;
  readonly repo: number;
  readonly persona: number;
  readonly title: number;
};

const STATUS_WIDTH = 12;
const MARK_WIDTH = 4;
const WHEN_WIDTH = 8;
const MIN_TITLE = 12;
const MIN_DETAIL = 24;

const widest = (texts: ReadonlyArray<string>, cap: number) =>
  Math.min(cap, Math.max(0, ...texts.map((text) => text.length)) + 1);

const widthIf = (condition: boolean, width: number) => {
  if (condition) {
    return width;
  }

  return 0;
};

const titleOf = (run: RunEntry) => Option.getOrElse(run.itemTitle, () => "");

// The fixed columns fit their longest value, within reason; the title takes
// what's left up to its longest, and the detail the rest.
// The flow, and for a closed thread how many other runs it holds.
const flowText = (row: RunRow) => {
  if (row.lead && !row.expanded && row.others > 0) {
    return `${row.run.flow} +${row.others}`;
  }

  return row.run.flow;
};

const runColumns = (rows: ReadonlyArray<RunRow>, width: number, shown: Shown): RunColumns => {
  const runs = rows.map((row) => row.run);

  const item = widest(
    runs.map((run) => itemText(itemRef(run.itemKey))),
    12,
  );

  const flow = widest(rows.map(flowText), 24);

  const repo = widthIf(
    shown.repo,
    widest(
      runs.map((run) => run.repo),
      18,
    ),
  );

  const personaWidth = widest(
    runs.map((run) => personaText(run.persona)),
    18,
  );

  // No column for the implicit persona alone.
  const persona = widthIf(shown.persona && personaWidth > 1, personaWidth);

  const fixed = MARK_WIDTH + STATUS_WIDTH + item + flow + repo + persona + 1 + WHEN_WIDTH + 1;
  const room = Math.max(0, width - fixed);
  const longest = widest(runs.map(titleOf), Number.POSITIVE_INFINITY);
  const detail = Math.min(MIN_DETAIL, Math.floor(room * 0.4));
  const title = Math.max(MIN_TITLE, Math.min(longest, room - detail));

  return { item, flow, repo, persona, title };
};

const column = (text: string, width: number) => {
  if (width === 0) {
    return "";
  }

  return pad(text, width);
};

// A thread's latest run is marked open or closed when it has others; the
// others hang under it.
const markOf = (row: RunRow) => {
  if (!row.lead) {
    return "  └ ";
  }

  if (row.others === 0) {
    return "    ";
  }

  if (row.expanded) {
    return "  ▾ ";
  }

  return "  ▸ ";
};

const runLine = (row: RunRow, columns: RunColumns, now: DateTime.Utc): Line => {
  const { run } = row;
  const ref = itemRef(run.itemKey);

  const when = ago(
    Option.orElse(run.finishedAt, () => Option.some(run.startedAt)),
    now,
  );

  return [
    segment(markOf(row), "dim"),
    segment(pad(run.status, STATUS_WIDTH), STATUS_STYLE[run.status]),
    segment(column(itemText(ref), columns.item), ITEM_STYLE[ref.kind]),
    segment(column(flowText(row), columns.flow)),
    segment(column(run.repo, columns.repo), "dim"),
    segment(column(personaText(run.persona), columns.persona), "dim"),
    segment(column(titleOf(run), columns.title)),
    segment(` ${pad(when, WHEN_WIDTH)} `, "dim"),
    segment(firstLine(runDetail(run)), detailStyle(run.status)),
  ];
};

const personaName = (persona: Persona) =>
  Option.match(persona, { onNone: () => "implicit", onSome: (login) => `@${login}` });

// The project tabs and the persona filter, each only when there's a choice to make.
const filterLines = (model: Model): ReadonlyArray<Line> => {
  const projects = projectsOf(model.status);
  const personas = personasOf(model.status);

  const tab = (name: string, chosen: boolean): Segment =>
    segment(` ${name} `, styleIf(chosen, "selected"));

  const tabs: Line = onlyIf(projects.length > 1, [
    tab("All", Option.isNone(model.project)),
    ...projects.flatMap((name) => [
      segment("·", "dim"),
      tab(name, Option.contains(model.project, name)),
    ]),
  ]);

  const persona: Line = onlyIf(personas.length > 1, [
    segment(`${onlyIf(tabs.length > 0, ["   "]).join("")}persona `, "dim"),
    segment(
      Option.match(model.personaFilter, { onNone: () => "all", onSome: personaName }),
      "bold",
    ),
  ]);

  if (tabs.length === 0 && persona.length === 0) {
    return [];
  }

  return [[], [...tabs, ...persona]];
};

// Held items the live view lists before saying how many more.
const HOLDS_SHOWN = 4;

const statusView = (model: Model, status: DaemonStatus): Array<Line> => {
  const { now } = model;
  const lines: Array<Line> = [];

  lines.push([
    segment("chernabog", "bold"),
    segment(
      `  daemon ${status.pid}, up ${ago(Option.some(status.startedAt), now).replace(" ago", "")}`,
      "dim",
    ),
    ...onlyIf(model.reconnecting, [segment("  reconnecting to the daemon…", "yellow")]),
    ...onlyIf(status.busy > 0, [
      segment(`  ${status.busy} step${plural(status.busy)} executing`, "cyan"),
    ]),
    ...onlyIf(status.draining === true, [
      segment("  draining: chernabog was upgraded; restarting on it once runs finish", "yellow"),
    ]),
    ...onlyIf(status.reloadPending && status.draining !== true, [
      segment("  restarting on new config when idle", "yellow"),
    ]),
  ]);

  for (const line of filterLines(model)) {
    lines.push(line);
  }

  lines.push([]);

  lines.push(heading("Repos and flows"));
  const flows = flowRows(model);
  const selectedFlow = Arr.get(flows, model.flowIndex);
  const shown = shownColumns(model);

  const labelOf = (flow: { readonly name: string; readonly persona?: string }) =>
    `${flow.name}${Option.match(
      Option.filter(Option.fromUndefinedOr(flow.persona), () => shown.persona),
      { onNone: () => "", onSome: (login) => ` @${login}` },
    )}`;

  // Where an imported flow comes from, after its row.
  const sourceOf = (flow: { readonly source?: string }) =>
    Option.toArray(
      Option.map(Option.fromUndefinedOr(flow.source), (source) => segment(`  · ${source}`, "dim")),
    );

  // Wide enough for a persona's name too, within reason.
  const flowColumn = Math.min(
    24,
    Math.max(
      12,
      ...status.repos.flatMap((repo) => repo.flows.map((flow) => labelOf(flow).length + 1)),
    ),
  );

  for (const repo of status.repos.filter((found) =>
    Option.match(model.project, { onNone: () => true, onSome: (name) => name === found.name }),
  )) {
    const state = repoState(repo);
    lines.push([
      segment(`  ${repo.name}`, "bold"),
      segment(`  ${state}`, stateStyle(state)),
      ...Option.toArray(
        Option.map(repo.launcher, (launcher) => segment(`  launcher ${launcher}`, "dim")),
      ),
      ...Option.toArray(Option.map(repo.message, (message) => segment(`  ${message}`, "dim"))),
    ]);

    for (const flow of repo.flows.filter((found) =>
      passes(model, repo.name, Option.fromUndefinedOr(found.persona)),
    )) {
      const persona = Option.fromUndefinedOr(flow.persona);

      const selected =
        model.focus === "flows" &&
        Option.exists(
          selectedFlow,
          (row) =>
            row.repo === repo.name && row.flow === flow.name && samePersona(row.persona, persona),
        );

      const enabled = flowEnabled(model, repo.name, flow);
      const timing = flowTiming(enabled, enabled !== flow.enabled, nextTickOf(flow, now));

      const why = Option.filter(
        Option.fromUndefinedOr(flow.offReason),
        (reason) => !enabled && reason !== FLOW_TURNED_OFF,
      );

      lines.push(
        select(
          [
            segment(`    ${pad(labelOf(flow), flowColumn)}`),
            timing,
            segment(
              `  ${Option.getOrElse(why, () => queueText(flow.queued, flow.assignedElsewhere ?? []))}`,
              "dim",
            ),
            ...sourceOf(flow),
            // What made its pending tick, or its last one.
            segment(
              Option.getOrElse(
                Option.map(
                  Option.orElse(Option.fromUndefinedOr(flow.pending), () =>
                    Option.fromUndefinedOr(flow.lastCause),
                  ),
                  (cause) => `  ${cause}`,
                ),
                () => "",
              ),
              "dim",
            ),
          ],
          selected,
        ),
      );
    }
  }

  lines.push([]);

  lines.push(heading("Usage"));

  if (model.usage.length === 0) {
    lines.push([segment("  no readings yet", "dim")]);
  }

  for (const row of model.usage) {
    const over =
      row.fiveHour >= model.thresholds.fiveHourCeiling ||
      row.sevenDay >= model.thresholds.targetEndUsage;

    const limits = `5h ${percent(row.fiveHour)} of ${Math.round(model.thresholds.fiveHourCeiling * 100)}%  week ${percent(row.sevenDay)} of ${Math.round(model.thresholds.targetEndUsage * 100)}%`;
    lines.push([
      segment(`  ${pad(row.account, 12)}`),
      segment(limits, styleIf(over, "yellow")),
      launchSegment(row.launch, ago(Option.some(row.at), now)),
    ]);
  }

  lines.push([]);

  lines.push(heading("Runs"));
  const runs = runRows(model);

  if (runs.length === 0) {
    lines.push([segment("  none yet", "dim")]);
  }

  const columns = runColumns(runs, model.width, shown);

  runs.forEach((row, runIndex) => {
    lines.push(
      select(runLine(row, columns, now), model.focus === "runs" && model.runIndex === runIndex),
    );
  });

  const holds = (status.holds ?? []).filter((hold) => passes(model, hold.repo, hold.persona));

  if (holds.length > 0) {
    lines.push([]);
    lines.push(heading("Held"));

    for (const hold of holds.slice(0, HOLDS_SHOWN)) {
      lines.push([
        segment(
          `  ${pad(hold.repo, 12)} ${hold.flow} ${itemText(itemRef(hold.itemKey))}: ${firstLine(hold.reason)}`,
          "dim",
        ),
      ]);
    }

    // The CLI lists them all; say how many more there are here.
    if (holds.length > HOLDS_SHOWN) {
      lines.push([
        segment(`  … ${holds.length - HOLDS_SHOWN} more (chernabog status lists them all)`, "dim"),
      ]);
    }
  }

  const skips = status.skips.filter((skip) => passes(model, skip.repo, skip.persona));

  if (skips.length > 0) {
    lines.push([]);
    lines.push(heading("Recent skips"));

    for (const skip of skips.slice(0, 4)) {
      lines.push([
        segment(`  ${pad(`${skip.repo}/${skip.flow}`, 22)} ${firstLine(skip.reason)}`, "dim"),
        segment(`  ${ago(Option.some(skip.at), now)}`, "dim"),
      ]);
    }
  }

  return lines;
};

const repoNamed = (model: Model, name: string) =>
  Option.flatMap(model.status, (status) =>
    Arr.findFirst(status.repos, (repo) => repo.name === name),
  );

// The persona's flows in a repo, as the daemon has them.
export const personaFlows = (model: Model, settings: Settings) =>
  Option.match(repoNamed(model, settings.repo), {
    onNone: () => [],
    onSome: (repo) =>
      repo.flows.filter((flow) =>
        samePersona(Option.fromUndefinedOr(flow.persona), settings.persona),
      ),
  });

export const personaAccounts = (model: Model, settings: Settings): Option.Option<PersonaStatus> =>
  Option.flatMap(repoNamed(model, settings.repo), (repo) =>
    Arr.findFirst(repo.personas ?? [], (found) =>
      samePersona(Option.fromUndefinedOr(found.persona), settings.persona),
    ),
  );

const ACCOUNT_ROW: SettingsRow = { kind: "account" };

export const sameRow = (left: SettingsRow, right: SettingsRow) => {
  if (left.kind === "flow" && right.kind === "flow") {
    return left.flow === right.flow;
  }

  if (left.kind === "role" && right.kind === "role") {
    return left.role === right.role;
  }

  return left.kind === right.kind;
};

const onOff = (enabled: boolean) => {
  if (enabled) {
    return "on";
  }

  return "off";
};

// The settings view's rows: the persona's flows, then its account and each role's.
export const settingsRows = (model: Model, settings: Settings): ReadonlyArray<SettingsRow> => [
  ...personaFlows(model, settings).map((flow): SettingsRow => ({ kind: "flow", flow: flow.name })),
  ...Option.match(personaAccounts(model, settings), {
    onNone: (): ReadonlyArray<SettingsRow> => [],
    onSome: (found) => [
      ACCOUNT_ROW,
      ...found.roles.map((role): SettingsRow => ({ kind: "role", role: role.role })),
    ],
  }),
];

const whose = (pick: Option.Option<string>, fallback: string) =>
  Option.match(pick, {
    onNone: () => `${fallback} (default)`,
    onSome: (name) => `${name} (yours)`,
  });

const editingLines = (editing: Editing): ReadonlyArray<Line> => {
  if (editing.kind === "cron") {
    return [
      [],
      [segment(`  schedule for ${editing.flow}: `, "bold"), segment(`${editing.text}▏`, "cyan")],
    ];
  }

  if (editing.kind === "pick") {
    const title = Option.match(editing.role, {
      onNone: () => "account",
      onSome: (role) => `account for ${role}`,
    });

    return [
      [],
      heading(`  Choose the ${title}`),
      ...editing.choices.map((choice, index) =>
        select([segment(`    ${choice}`)], index === editing.index),
      ),
    ];
  }

  return [];
};

const settingsView = (model: Model, settings: Settings): ReadonlyArray<Line> => {
  const who = Option.match(settings.persona, {
    onNone: () => "",
    onSome: (login) => ` as ${login}`,
  });

  const rows = settingsRows(model, settings);
  const browsing = settings.editing.kind === "browse";

  const isSelected = (row: SettingsRow) =>
    browsing && Option.exists(Arr.get(rows, settings.index), (found) => sameRow(found, row));

  const lines: Array<Line> = [
    [
      segment(`${settings.repo}${who}`, "bold"),
      segment("  saved to machine config; the daemon picks changes up when idle", "dim"),
    ],
    [],
    heading("Flows"),
  ];

  for (const flow of personaFlows(model, settings)) {
    const enabled = flowEnabled(model, settings.repo, flow);

    const schedule = Option.match(Option.fromUndefinedOr(flow.ownSchedule), {
      onNone: () => {
        if (flow.manual === true) {
          return segment(flow.schedule, "dim");
        }

        return segment(`${pad(flow.schedule, 16)} team's`, "plain");
      },
      onSome: (own) =>
        segment(`${pad(own, 16)} yours; team's ${flow.teamSchedule ?? flow.schedule}`, "cyan"),
    });

    lines.push(
      select(
        [
          segment(`  ${pad(flow.name, 14)}`),
          segment(pad(onOff(enabled), 5), styleIf(!enabled, "dim")),
          schedule,
          segment(`  next ${nextTickOf(flow, model.now)}`, "dim"),
        ],
        isSelected({ kind: "flow", flow: flow.name }),
      ),
    );
  }

  for (const found of Option.toArray(personaAccounts(model, settings))) {
    lines.push([], heading("Accounts"));
    lines.push(
      select(
        [segment(`  ${pad("account", 20)}`), segment(whose(found.ownAccount, found.account))],
        isSelected(ACCOUNT_ROW),
      ),
    );

    for (const role of found.roles) {
      lines.push(
        select(
          [
            segment(`  ${pad(`role ${role.role}`, 20)}`),
            segment(whose(role.account, "its agent's account")),
          ],
          isSelected({ kind: "role", role: role.role }),
        ),
      );
    }
  }

  return [...lines, ...editingLines(settings.editing)];
};

const mainView = (model: Model): ReadonlyArray<Line> =>
  Option.match(model.status, {
    onNone: () => [
      [
        segment(
          Option.getOrElse(model.error, () => "connecting to the daemon…"),
          "yellow",
        ),
      ],
    ],
    onSome: (status) => statusView(model, status),
  });

const logView = (model: Model): ReadonlyArray<Line> => {
  const run = Arr.findFirst(allRuns(model.status), (candidate) =>
    Option.contains(model.logRun, candidate.id),
  );

  const header: ReadonlyArray<Line> = [
    [
      segment(
        Option.getOrElse(model.logRun, () => ""),
        "bold",
      ),
      ...Option.toArray(
        Option.map(run, (found) =>
          segment(
            `  ${found.status}${Option.match(found.currentStep, { onNone: () => "", onSome: (step) => `: ${step}` })}`,
            STATUS_STYLE[found.status],
          ),
        ),
      ),
      ...Option.toArray(
        Option.map(model.logOf, (node) => segment(`  log of ${node.name}`, "bold")),
      ),
    ],
    [],
  ];

  const room = Math.max(1, model.height - header.length - 2);
  const end = Math.max(0, model.logLines.length - model.logScroll);

  const shown = model.logLines
    .slice(Math.max(0, end - room), end)
    .map((line): Line => [
      segment(line, styleIf(/error|failed|needs a person/i.test(line), "red")),
    ]);

  return [...header, ...shown];
};

// A stretch of a run's path: a step, how many times over it ran in a row,
// and the seconds it took in all.
export type PathStep = { readonly step: string; readonly times: number; readonly seconds: number };

const epochSeconds = (iso: string) =>
  Option.map(DateTime.make(iso), (at) => DateTime.toEpochMillis(at) / 1000);

// The steps a run took, tidied, with repeats in a row folded into one: each
// step lasts until the next one starts, and the last until the run finished,
// or until now.
export const pathOf = (
  history: RunHistory,
  finishedAt: Option.Option<string>,
  now: DateTime.Utc,
): ReadonlyArray<PathStep> => {
  const end = Option.getOrElse(Option.flatMap(finishedAt, epochSeconds), () =>
    Math.round(DateTime.toEpochMillis(now) / 1000),
  );

  const lasted = history.steps.map((entered, index) => {
    const from = Option.getOrElse(epochSeconds(entered.enteredAt), () => end);

    const until = Option.getOrElse(
      Option.flatMap(Arr.get(history.steps, index + 1), (next) => epochSeconds(next.enteredAt)),
      () => end,
    );

    return { step: tidyStep(entered.step), seconds: Math.max(0, until - from) };
  });

  const path: Array<PathStep> = [];

  for (const entered of lasted) {
    const last = Arr.last(path);

    if (Option.isSome(last) && last.value.step === entered.step) {
      path[path.length - 1] = {
        step: entered.step,
        times: last.value.times + 1,
        seconds: last.value.seconds + entered.seconds,
      };
      continue;
    }

    path.push({ step: entered.step, times: 1, seconds: entered.seconds });
  }

  return path;
};

// How the last step on a run's path ended: still going, or how the run did.
const LAST_MARK: Readonly<Record<RunStatus, Segment>> = {
  running: segment("●", "cyan"),
  done: segment("✓", "green"),
  failed: segment("✗", "red"),
  "needs-human": segment("!", "yellow"),
  cancelled: segment("✗", "dim"),
  superseded: segment("↷", "dim"),
  lost: segment("↷", "yellow"),
  skipped: segment("○", "dim"),
};

const durationText = (seconds: number) => spanText(Math.round(seconds));

// The path's steps as lines, `✓ claim 2s ─ ● ci ×4 5m`, wrapped to `width`.
const pathLines = (
  path: ReadonlyArray<PathStep>,
  status: RunStatus,
  width: number,
): ReadonlyArray<Line> => {
  const tokens = path.map((step, index): Line => {
    const mark = Option.getOrElse(
      Option.as(
        Option.liftPredicate(index, (at) => at === path.length - 1),
        LAST_MARK[status],
      ),
      () => segment("✓", "green"),
    );

    return [
      mark,
      segment(` ${step.step}`),
      ...onlyIf(step.times > 1, [segment(` ×${step.times}`, "bold")]),
      segment(` ${durationText(step.seconds)}`, "dim"),
    ];
  });

  const lines: Array<Line> = [];
  let used = 0;

  for (const token of tokens) {
    const length = token.reduce((sum, part) => sum + part.text.length, 0);
    const current = Arr.last(lines);

    if (Option.isNone(current) || used + 3 + length > width) {
      lines.push([segment("  "), ...token]);
      used = 2 + length;
      continue;
    }

    lines[lines.length - 1] = [...current.value, segment(" ─ ", "dim"), ...token];
    used += 3 + length;
  }

  return lines;
};

const itemLine = (run: RunEntry): Line => {
  const ref = itemRef(run.itemKey);

  const named = Option.getOrElse(
    Option.as(
      Option.liftPredicate(ref, (found) => found.kind === "issue"),
      `issue ${itemText(ref)}`,
    ),
    () => itemText(ref),
  );

  return [
    segment(named, ITEM_STYLE[ref.kind]),
    ...Option.toArray(Option.map(run.itemTitle, (title) => segment(`  ${title}`))),
    ...Option.toArray(Option.map(run.itemUrl, (url) => segment(`  ${url}`, "dim"))),
  ];
};

// The step a run was in when it parked: the last it entered by then.
const parkedIn = (history: RunHistory, parkedAt: string) =>
  Option.map(
    Arr.findLast(history.steps, (step) => step.enteredAt <= parkedAt),
    (step) => tidyStep(step.step),
  );

const waitLines = (run: RunEntry, history: RunHistory, now: DateTime.Utc): ReadonlyArray<Line> =>
  onlyIf(run.status === "running" && history.waits.length > 0, [
    [],
    heading("Waiting"),
    ...history.waits.map((wait): Line => {
      const since = Option.match(wait.parkedAt, {
        onNone: () => "",
        onSome: (at) =>
          `${Option.match(parkedIn(history, at), { onNone: () => "", onSome: (step) => ` since ${step}` })}, for ${ago(Option.some(at), now).replace(" ago", "")}`,
      });

      return [segment("  for "), segment(wait.signal, "yellow"), segment(since, "dim")];
    }),
  ]);

const historyLines = (run: RunEntry, model: Model): ReadonlyArray<Line> =>
  Option.match(model.history, {
    onNone: () => [[segment("  the daemon hasn't said yet", "dim")]],
    onSome: (history) => {
      if (history.steps.length === 0) {
        return [
          [
            segment(
              "  no steps recorded: this run started before chernabog kept them; l shows its log",
              "dim",
            ),
          ],
          ...waitLines(run, history, model.now),
        ];
      }

      return [
        ...pathLines(pathOf(history, run.finishedAt, model.now), run.status, model.width - 2),
        ...waitLines(run, history, model.now),
      ];
    },
  });

// --- A run on its plan, as a vertical tree ---------------------------------
//
// A run of a flow with a plan is drawn on it (RunOnPlan), one node a line,
// set up first and wrap up last: each node's state and the time in it, an
// outcome branch under its node, a branch the run didn't take folded to one
// dim line, a repeat as an indented block of one round at a time, and a
// forEach as a line per lane, each lane's steps folded under it until
// unfolded. A terminal keeps the tree's width and scrolls it.

type RunStepOnPlan = NodeOnPlan["steps"][number];

// A line of the tree: the guides before it, its state's mark, its name and
// how long it took; and what selecting it gives, for a line a person can select.
type TreeRow = {
  readonly guide: string;
  readonly mark: Option.Option<Segment>;
  readonly name: string;
  readonly style: Style;
  readonly time: string;
  readonly target: Option.Option<DetailTarget>;
};

// What the tree shows of the run: the lanes unfolded, the round each repeat
// shows, the time now, and how a node is drawn, for what is drawn under it.
type TreeOptions = {
  readonly unfolded: ReadonlyArray<string>;
  readonly rounds: Readonly<Record<string, number>>;
  readonly now: DateTime.Utc;
  readonly nodeRows: (
    node: NodeOnPlan,
    guide: string,
    options: TreeOptions,
  ) => ReadonlyArray<TreeRow>;
};

// What a node shows after its name, and the rows under it.
type Inside = { readonly after: string; readonly rows: ReadonlyArray<TreeRow> };

const STATE_MARK: Readonly<Record<NodeState, Segment>> = {
  ok: segment("✓", "green"),
  failed: segment("✗", "red"),
  running: segment("●", "cyan"),
  waiting: segment("◐", "yellow"),
  "not-taken": segment("○", "dim"),
  "not-reached": segment("○", "dim"),
};

const UNRUN_STATES: ReadonlyArray<NodeState> = ["not-taken", "not-reached"];

const LIVE_STATES: ReadonlyArray<NodeState> = ["running", "waiting"];

// A node in its round and lane, as one key, as a run's history keys it: `ci@2#task-10`.
const keyOfNode = (node: NodeOnPlan) =>
  [
    node.node.id,
    ...Option.toArray(Option.map(node.round, (round) => `@${round}`)),
    ...Option.toArray(Option.map(node.lane, (lane) => `#${lane}`)),
  ].join("");

// How long a node took, or has taken so far: none for one the run never entered.
const timeIn = (
  span: {
    readonly startedAt: Option.Option<string>;
    readonly endedAt: Option.Option<string>;
    readonly state: NodeState;
  },
  now: DateTime.Utc,
) =>
  Option.match(Option.flatMap(span.startedAt, epochSeconds), {
    onNone: () => "",
    onSome: (start) => {
      const end = Option.getOrElse(
        Option.flatMap(
          Option.filter(span.endedAt, () => !LIVE_STATES.includes(span.state)),
          epochSeconds,
        ),
        () => DateTime.toEpochMillis(now) / 1000,
      );

      return durationText(Math.max(0, end - start));
    },
  });

const loggedAt = (step: RunStepOnPlan): LoggedAt => ({
  step: step.step,
  ...Option.match(Option.fromUndefinedOr(step.node), {
    onNone: () => ({}),
    onSome: (node) => ({ node }),
  }),
});

// Every engine step the run ran at a node or under it, in every round and lane.
const stepsUnder = (node: NodeOnPlan): ReadonlyArray<RunStepOnPlan> => {
  const inside = Arr.match(node.rounds, {
    onEmpty: () => node.body,
    onNonEmpty: (rounds) => rounds.flatMap((round) => round.steps),
  });

  return [
    ...node.steps,
    ...node.branches.flatMap((branch) => branch.steps.flatMap(stepsUnder)),
    ...inside.flatMap(stepsUnder),
    ...node.lanes.flatMap((lane) => [...lane.steps, ...lane.body.flatMap(stepsUnder)]),
  ];
};

const nameOf = (node: NodeOnPlan) => {
  switch (node.node.kind) {
    case "end":
      return node.node.end;
    case "next":
      return "next round";
    case "first":
      return `first of ${node.node.first.join(", ")}`;
    case "if":
      return `if ${node.node.condition}`;
    default:
      return node.node.id;
  }
};

const markOfNode = (node: NodeOnPlan): Segment => {
  if (node.node.kind === "end" && node.state === "ok") {
    return segment("◇", "green");
  }

  if (node.node.kind === "end") {
    return segment("◇", "dim");
  }

  return STATE_MARK[node.state];
};

const nameStyle = (state: NodeState): Style => {
  if (UNRUN_STATES.includes(state)) {
    return "dim";
  }

  return "plain";
};

const connector = (last: boolean) => {
  if (last) {
    return "└─ ";
  }

  return "├─ ";
};

const continuation = (last: boolean) => {
  if (last) {
    return "   ";
  }

  return "│  ";
};

const target = (
  key: string,
  label: string,
  steps: ReadonlyArray<RunStepOnPlan>,
  more: Partial<Pick<DetailTarget, "lanes" | "repeat">> = {},
): Option.Option<DetailTarget> =>
  Option.some({
    key,
    label,
    only: steps.map(loggedAt),
    lanes: more.lanes ?? [],
    repeat: more.repeat ?? Option.none(),
  });

const textRow = (guide: string, name: string, style: Style): TreeRow => ({
  guide,
  mark: Option.none(),
  name,
  style,
  time: "",
  target: Option.none(),
});

const lanesText = (count: number) => `${count} lane${plural(count)}`;

// The rows of a sequence of nodes, each under `guide`.
const sequenceRows = (
  nodes: ReadonlyArray<NodeOnPlan>,
  guide: string,
  options: TreeOptions,
): ReadonlyArray<TreeRow> => nodes.flatMap((node) => options.nodeRows(node, guide, options));

// A block's or a stage's outcome branches: each under its node, the one it
// went down open, and one it didn't take folded to one dim line.
const branchRows = (
  node: NodeOnPlan,
  guide: string,
  options: TreeOptions,
): ReadonlyArray<TreeRow> =>
  node.branches.flatMap((branch, index) => {
    const last = index === node.branches.length - 1;
    const left = !branch.taken && ["ok", "failed", "not-taken"].includes(node.state);

    if (left) {
      return [
        textRow(
          `${guide}${connector(last)}`,
          `${[branch.outcome, ...branch.steps.map(nameOf)].join("  ·  ")}  (not taken)`,
          "dim",
        ),
      ];
    }

    return [
      textRow(`${guide}${connector(last)}`, branch.outcome, nameStyle(node.state)),
      ...sequenceRows(branch.steps, `${guide}${continuation(last)}`, options),
    ];
  });

// The round of a repeat it shows: the one a person chose, else its latest.
const roundShown = (node: NodeOnPlan, options: TreeOptions) =>
  Math.min(
    node.rounds.length,
    Math.max(
      1,
      Option.getOrElse(Record.get(options.rounds, keyOfNode(node)), () => node.rounds.length),
    ),
  );

// A forEach's lanes, each a line with its steps under it once unfolded.
const laneRows = (node: NodeOnPlan, guide: string, options: TreeOptions): ReadonlyArray<TreeRow> =>
  node.lanes.flatMap((lane, index) => {
    const last = index === node.lanes.length - 1;
    const key = `${keyOfNode(node)}#${lane.lane}`;

    return [
      {
        guide: `${guide}${connector(last)}`,
        mark: Option.some(STATE_MARK[lane.state]),
        name: lane.lane,
        style: nameStyle(lane.state),
        time: timeIn(lane, options.now),
        target: target(key, lane.lane, [...lane.steps, ...lane.body.flatMap(stepsUnder)], {
          lanes: [key],
        }),
      },
      ...onlyIf(
        options.unfolded.includes(key),
        sequenceRows(lane.body, `${guide}${continuation(last)}`, options),
      ),
    ];
  });

const laneKeys = (node: NodeOnPlan) => node.lanes.map((lane) => `${keyOfNode(node)}#${lane.lane}`);

const inside = (node: NodeOnPlan, guide: string, options: TreeOptions): Inside => {
  const block = `${guide}│  `;

  switch (node.node.kind) {
    case "use":
    case "stage":
      return { after: "", rows: branchRows(node, guide, options) };
    case "if":
      return { after: "", rows: sequenceRows(node.body, block, options) };
    case "repeat":
      return Arr.match(node.rounds, {
        onEmpty: () => ({ after: "", rows: sequenceRows(node.body, block, options) }),
        onNonEmpty: (rounds) => {
          const shown = roundShown(node, options);

          return {
            after: `  round ${shown} of ${rounds.length}`,
            rows: sequenceRows(
              Option.match(Arr.get(rounds, shown - 1), {
                onNone: () => node.body,
                onSome: (round) => round.steps,
              }),
              block,
              options,
            ),
          };
        },
      });
    case "forEach":
      return Arr.match(node.lanes, {
        onEmpty: () => ({ after: "", rows: sequenceRows(node.body, block, options) }),
        onNonEmpty: (lanes) => ({
          after: `  ${lanesText(lanes.length)}`,
          rows: laneRows(node, guide, options),
        }),
      });
    default:
      return { after: "", rows: [] };
  }
};

// A node's row, with the ones under it.
const nodeRows = (
  node: NodeOnPlan,
  guide: string,
  options: TreeOptions,
): ReadonlyArray<TreeRow> => {
  const under = inside(node, guide, options);
  const name = nameOf(node);

  const left = onlyIf(node.left, ["  ← the run left its plan here"]).join("");

  const time = Option.getOrElse(
    Option.as(
      Option.liftPredicate(node, (found) => found.node.kind === "end"),
      "",
    ),
    () => timeIn(node, options.now),
  );

  return [
    {
      guide,
      mark: Option.some(markOfNode(node)),
      name: `${name}${under.after}${left}`,
      style: nameStyle(node.state),
      time,
      target: target(keyOfNode(node), name, stepsUnder(node), {
        lanes: laneKeys(node),
        repeat: Option.map(
          Option.liftPredicate(node, (found) => found.rounds.length > 1),
          (found) => ({ key: keyOfNode(found), rounds: found.rounds.length }),
        ),
      }),
    },
    ...under.rows,
  ];
};

const offPlanRow = (name: string, off: OffPlan, now: DateTime.Utc): TreeRow => ({
  guide: "",
  mark: Option.some(STATE_MARK[off.state]),
  name,
  style: nameStyle(off.state),
  time: timeIn(off, now),
  // Set up and wrap up by a key no node of a plan has: a node's id never starts with a colon.
  target: target(`:${name}`, name, off.steps),
});

// The run in the detail view on its plan, as the tree's rows: none for a run
// with no plan, or one whose plan hasn't come yet.
const planRows = (model: Model): Option.Option<ReadonlyArray<TreeRow>> =>
  Option.gen(function* () {
    const run = yield* Arr.findFirst(allRuns(model.status), (candidate) =>
      Option.contains(model.detailRun, candidate.id),
    );

    const history = yield* model.history;
    const plan = yield* Option.filter(model.plan, (found) => history.plan === found.hash);
    const drawn = RunOnPlan.draw(plan, history, { status: run.status });

    const options: TreeOptions = {
      unfolded: model.unfolded,
      rounds: model.rounds,
      now: model.now,
      nodeRows,
    };

    return [
      offPlanRow("set up", drawn.setUp, model.now),
      ...sequenceRows(drawn.steps, "", options),
      offPlanRow("wrap up", drawn.wrapUp, model.now),
    ];
  });

// The lines of the tree a person can select, in order.
export const detailTargets = (model: Model): ReadonlyArray<DetailTarget> =>
  Option.match(planRows(model), {
    onNone: () => [],
    onSome: (rows) => rows.flatMap((row) => Option.toArray(row.target)),
  });

// The steps whose lines the log view shows, for the node of the plan it is
// the log of: those the run's history now has for it, so the log follows the
// node as the run enters its steps, rounds and lanes.
export const nodeLogOnly = (model: Model): Option.Option<ReadonlyArray<LoggedAt>> =>
  Option.map(model.logOf, (node) =>
    Option.match(
      Arr.findFirst(detailTargets(model), (found) => found.key === node.key),
      { onNone: () => node.only, onSome: (found) => found.only },
    ),
  );

// The model after a refresh, with the same line of the detail view
// selected: the same node of the plan, wherever new rounds and lanes moved
// it, or the same run of the thread, after however many nodes come first now.
export const reselected = (before: Model, after: Model): Model => {
  const was = detailTargets(before);
  const now = detailTargets(after);

  const index = Option.match(Arr.get(was, before.detailIndex), {
    onNone: () => before.detailIndex - was.length + now.length,
    onSome: (selected) =>
      Option.getOrElse(
        Arr.findFirstIndex(now, (found) => found.key === selected.key),
        () => after.detailIndex,
      ),
  });

  return { ...after, detailIndex: Math.max(0, index) };
};

const TREE_INDENT = 2;

// A name cut to `width`, with an ellipsis when it was longer, and padded to it.
const fitted = (text: string, width: number) => {
  if (text.length > width) {
    return `${text.slice(0, Math.max(0, width - 1))}…`;
  }

  return text.padEnd(width);
};

const markWidth = (row: TreeRow) =>
  Option.match(row.mark, { onNone: () => 0, onSome: (mark) => mark.text.length + 1 });

// The tree's rows as lines, every time right-aligned in one column, within
// `width`; the `selected`th selectable row highlighted.
const treeLines = (
  rows: ReadonlyArray<TreeRow>,
  width: number,
  selected: number,
): ReadonlyArray<Line> => {
  const timeWidth = Math.max(0, ...rows.map((row) => row.time.length));

  const longest = Math.max(
    0,
    ...rows.map((row) => row.guide.length + markWidth(row) + row.name.length),
  );

  const nameWidth = Math.max(1, Math.min(longest, width - TREE_INDENT - 2 - timeWidth));
  let selectable = -1;

  return rows.map((row) => {
    const lead = row.guide.length + markWidth(row);

    const line: Line = [
      segment(" ".repeat(TREE_INDENT)),
      segment(row.guide, "dim"),
      ...Option.match(row.mark, {
        onNone: () => [],
        onSome: (mark) => [mark, segment(" ")],
      }),
      segment(fitted(row.name, Math.max(1, nameWidth - lead)), row.style),
      ...onlyIf(row.time.length > 0, [segment(`  ${row.time.padStart(timeWidth)}`, "dim")]),
    ];

    if (Option.isNone(row.target)) {
      return line;
    }

    selectable += 1;

    return select(line, selectable === selected);
  });
};

// The other runs of the run's piece of work, each of which opens its own detail.
const threadLines = (model: Model, run: RunEntry): ReadonlyArray<Line> => {
  const others = threadRuns(model, run.id);
  const before = detailTargets(model).length;

  return onlyIf(others.length > 0, [
    [],
    heading("Thread"),
    ...others.map((other, index) => {
      const ref = itemRef(other.itemKey);

      return select(
        [
          segment(`  ${pad(other.status, STATUS_WIDTH)}`, STATUS_STYLE[other.status]),
          segment(`${itemText(ref)} `, ITEM_STYLE[ref.kind]),
          segment(other.flow),
          segment(
            `${Option.match(other.persona, { onNone: () => "", onSome: (login) => ` @${login}` })}  ${ago(
              Option.orElse(other.finishedAt, () => Option.some(other.startedAt)),
              model.now,
            )}`,
            "dim",
          ),
          segment(`  ${firstLine(runDetail(other))}`, detailStyle(other.status)),
        ],
        before + index === model.detailIndex,
      );
    }),
  ]);
};

// Where the run has been: on its plan, as a tree, for a run with one; else its path.
const whereLines = (run: RunEntry, model: Model): ReadonlyArray<Line> =>
  Option.match(planRows(model), {
    onNone: () => [heading("Path"), ...historyLines(run, model)],
    onSome: (rows) => [
      heading("Plan"),
      ...treeLines(rows, model.width, model.detailIndex),
      ...Option.match(model.history, {
        onNone: () => [],
        onSome: (history) => waitLines(run, history, model.now),
      }),
    ],
  });

// One run: what it's about and as whom, where it works, the steps it has
// taken, and the other runs of its piece of work.
const runView = (model: Model): ReadonlyArray<Line> => {
  const found = Arr.findFirst(allRuns(model.status), (candidate) =>
    Option.contains(model.detailRun, candidate.id),
  );

  return Option.match(found, {
    onNone: () => [
      [
        segment(
          `${Option.getOrElse(model.detailRun, () => "")} is no longer among the runs the daemon reports`,
          "yellow",
        ),
      ],
    ],
    onSome: (run) => [
      [
        segment(`${run.repo} · ${run.flow}`, "bold"),
        ...Option.toArray(Option.map(run.persona, (login) => segment(` · @${login}`, "bold"))),
        segment(`  ${run.id}`, "dim"),
      ],
      itemLine(run),
      [
        segment(run.status, STATUS_STYLE[run.status]),
        segment(`  started ${ago(Option.some(run.startedAt), model.now)}`, "dim"),
        ...Option.toArray(
          Option.map(run.finishedAt, (at) =>
            segment(` · finished ${ago(Option.some(at), model.now)}`, "dim"),
          ),
        ),
        ...Option.toArray(Option.map(run.summary, (summary) => segment(`  ${firstLine(summary)}`))),
      ],
      [
        segment("worktree  ", "dim"),
        segment(Option.getOrElse(model.worktree, () => "none yet: no agent session has started")),
      ],
      [],
      ...whereLines(run, model),
      ...threadLines(model, run),
    ],
  });
};

// The footer's two lines.
const FOOTER = 2;

// A view's lines from where the selected one shows, for a view longer than the terminal.
const scrolledTo = (lines: ReadonlyArray<Line>, height: number): ReadonlyArray<Line> => {
  const selected = lines.findIndex((line) => line.some((part) => part.style === "selected"));
  const room = Math.max(1, height - FOOTER);

  return lines.slice(Math.max(0, selected - room + 2));
};

const clipLine = (line: Line, width: number): Line => {
  const out: Array<Segment> = [];
  let used = 0;

  for (const part of line) {
    if (used >= width) {
      break;
    }

    const text = part.text.slice(0, width - used);
    out.push({ ...part, text });
    used += text.length;
  }

  return out;
};

const bodyOf = (model: Model) => {
  if (model.view === "log") {
    return logView(model);
  }

  if (model.view === "run") {
    return scrolledTo(runView(model), model.height);
  }

  return Option.match(
    Option.filter(model.settings, () => model.view === "settings"),
    { onNone: () => mainView(model), onSome: (settings) => settingsView(model, settings) },
  );
};

const SETTINGS_KEYS: Readonly<Record<Editing["kind"], string>> = {
  browse: KEYS_SETTINGS,
  cron: KEYS_CRON,
  pick: KEYS_PICK,
};

const keysOf = (model: Model) => {
  if (model.view === "log") {
    return KEYS_LOG;
  }

  if (model.view === "run") {
    return KEYS_RUN;
  }

  return Option.match(
    Option.filter(model.settings, () => model.view === "settings"),
    { onNone: () => KEYS_MAIN, onSome: (settings) => SETTINGS_KEYS[settings.editing.kind] },
  );
};

// The whole screen: the view, then the message and the keys on the last lines.
export const view = (model: Model): ReadonlyArray<Line> => {
  const footer: ReadonlyArray<Line> = [
    Option.match(model.message, {
      onNone: () => [],
      onSome: (message) => [segment(message, "yellow")],
    }),
    [segment(keysOf(model), "dim")],
  ];

  const room = Math.max(0, model.height - footer.length);

  const clipped = bodyOf(model)
    .slice(0, room)
    .map((line) => clipLine(line, model.width));

  return [
    ...clipped,
    ...Array.from({ length: room - clipped.length }, (): Line => []),
    ...footer.map((line) => clipLine(line, model.width)),
  ];
};

export const plain = (lines: ReadonlyArray<Line>) =>
  lines
    .map((line) =>
      line
        .map((part) => part.text)
        .join("")
        .trimEnd(),
    )
    .join("\n");
