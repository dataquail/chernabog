// What the TUI shows, as plain lines of styled segments: the view is a pure
// function of the model, so it can be tested without a terminal.

import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import { type Persona, samePersona } from "../../kernel/persona.value-object.ts";
import { FLOW_TURNED_OFF } from "../../modules/enrollment/use-cases/enrolled-repos.result.ts";
import { ActiveRun } from "../../modules/runs/use-cases/run.result.ts";
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
  readonly view: "main" | "log" | "settings";
  readonly settings: Option.Option<Settings>;
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

// The runs the list shows, through the filters.
export const runRows = (model: Model): ReadonlyArray<RunEntry> =>
  allRuns(model.status)
    .filter((run) => passes(model, run.repo, run.persona))
    .slice(0, MAX_RUNS);

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
  "tab switch pane · ↑↓ select · enter log or settings · 0-9 [ ] project · @ persona · a attach · x cancel run · t trigger · e flow on/off · p pause/resume · r refresh · q quit";

export const KEYS_LOG = "↑↓ scroll · end follow · a attach · esc back · q quit";

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

const runDetail = (run: RunEntry) => {
  if (run.status !== "running") {
    return Option.getOrElse(run.summary, () => "");
  }

  if (run.parked) {
    return "waiting for a signal";
  }

  return Option.getOrElse(run.currentStep, () => "starting");
};

const flowTiming = (
  enabled: boolean,
  pending: boolean,
  next: Option.Option<string>,
  now: DateTime.Utc,
) => {
  if (pending && enabled) {
    return segment(pad("on, pending", 14), "yellow");
  }

  if (pending) {
    return segment(pad("off, pending", 14), "yellow");
  }

  if (enabled) {
    return segment(`next ${pad(ago(next, now), 9)}`);
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
const runColumns = (runs: ReadonlyArray<RunEntry>, width: number, shown: Shown): RunColumns => {
  const item = widest(
    runs.map((run) => itemText(itemRef(run.itemKey))),
    12,
  );

  const flow = widest(
    runs.map((run) => run.flow),
    20,
  );

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

  const fixed = 2 + STATUS_WIDTH + item + flow + repo + persona + 1 + WHEN_WIDTH + 1;
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

const runLine = (run: RunEntry, columns: RunColumns, now: DateTime.Utc): Line => {
  const ref = itemRef(run.itemKey);

  const when = ago(
    Option.orElse(run.finishedAt, () => Option.some(run.startedAt)),
    now,
  );

  return [
    segment(`  ${pad(run.status, STATUS_WIDTH)}`, STATUS_STYLE[run.status]),
    segment(column(itemText(ref), columns.item), ITEM_STYLE[ref.kind]),
    segment(column(run.flow, columns.flow)),
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
      const timing = flowTiming(enabled, enabled !== flow.enabled, flow.next, now);

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

  runs.forEach((run, runIndex) => {
    lines.push(
      select(runLine(run, columns, now), model.focus === "runs" && model.runIndex === runIndex),
    );
  });

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
          segment(`  next ${ago(flow.next, model.now)}`, "dim"),
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
