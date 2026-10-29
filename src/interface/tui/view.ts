// What the TUI shows, as plain lines of styled segments: the view is a pure
// function of the model, so it can be tested without a terminal.

import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import { type Persona, samePersona } from "../../kernel/persona.value-object.ts";
import { FLOW_TURNED_OFF } from "../../modules/enrollment/use-cases/enrolled-repos.result.ts";
import { ActiveRun } from "../../modules/runs/use-cases/run.result.ts";
import { type RunHistory } from "../../modules/runs/use-cases/run-history.result.ts";
import type { DaemonStatus, PersonaStatus, RepoStatus } from "../daemon/daemon.protocol.ts";

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
  // The selected run among the detail view's thread.
  readonly threadIndex: number;
  readonly view: "main" | "log" | "settings" | "run";
  readonly settings: Option.Option<Settings>;
  // The run the detail view shows, where it has been, once the daemon has
  // said, and the worktree its latest agent session ran in.
  readonly detailRun: Option.Option<string>;
  readonly history: Option.Option<RunHistory>;
  readonly worktree: Option.Option<string>;
  readonly logRun: Option.Option<string>;
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
  "↑↓ select in thread · enter open it · l log · a attach · x cancel run · esc back · q quit";

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

  return `${queuedText(queued)} · ${elsewhere.length} assigned elsewhere`;
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

// The other runs of the run's piece of work, each of which opens its own detail.
const threadLines = (model: Model, run: RunEntry): ReadonlyArray<Line> => {
  const others = threadRuns(model, run.id);

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
        index === model.threadIndex,
      );
    }),
  ]);
};

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
      heading("Path"),
      ...historyLines(run, model),
      ...threadLines(model, run),
    ],
  });
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
    return runView(model);
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
