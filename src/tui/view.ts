// What the TUI shows, as plain lines of styled segments: the view is a pure
// function of the model, so it can be tested without a terminal.

import * as Arr from 'effect/Array';
import * as DateTime from 'effect/DateTime';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';

import { samePersona } from '../persona.ts';
import type { ActiveRun, DaemonStatus, RepoStatus } from '../protocol.ts';
import { FLOW_TURNED_OFF } from '../repo-config.ts';
import type { RunStatus } from '../state.ts';

export type Style = 'plain' | 'bold' | 'dim' | 'green' | 'red' | 'yellow' | 'cyan' | 'magenta' | 'selected';

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
export type FlowRow = { readonly repo: string; readonly flow: string; readonly persona: Option.Option<string> };

export type RunEntry = typeof ActiveRun.Type;

export type Model = {
  readonly status: Option.Option<DaemonStatus>;
  readonly error: Option.Option<string>;
  readonly usage: ReadonlyArray<UsageRow>;
  readonly thresholds: { readonly fiveHourCeiling: number; readonly targetEndUsage: number };
  readonly focus: 'flows' | 'runs';
  readonly flowIndex: number;
  readonly runIndex: number;
  readonly view: 'main' | 'log';
  readonly logRun: Option.Option<string>;
  readonly logLines: ReadonlyArray<string>;
  // Lines up from the bottom of the log; 0 follows it as it grows.
  readonly logScroll: number;
  readonly message: Option.Option<string>;
  // Flows turned on or off from here that the daemon hasn't restarted on yet, by flowKey.
  readonly pendingFlows: Readonly<Record<string, boolean>>;
  readonly width: number;
  readonly height: number;
  readonly now: DateTime.Utc;
};

const segment = (text: string, style: Style = 'plain'): Segment => ({ text, style });

export const flowKey = (repo: string, flow: string) => `${repo}/${flow}`;

// Whether a flow runs on this machine: as turned from here, else as the daemon
// has it. Turning a flow on or off is the same for each of its personas, as
// local.yaml has it.
export const flowEnabled = (model: Model, repo: string, flow: { readonly name: string; readonly enabled: boolean }) =>
  Option.getOrElse(Record.get(model.pendingFlows, flowKey(repo, flow.name)), () => flow.enabled);

const onlyIf = <A>(condition: boolean, items: ReadonlyArray<A>): ReadonlyArray<A> => {
  if (condition) return items;

  return [];
};

const styleIf = (condition: boolean, style: Style): Style => {
  if (condition) return style;

  return 'plain';
};

export const flowRows = (status: Option.Option<DaemonStatus>): ReadonlyArray<FlowRow> =>
  Option.match(status, {
    onNone: () => [],
    onSome: (found) => found.repos.flatMap((repo) => repo.flows.map((flow): FlowRow => ({ repo: repo.name, flow: flow.name, persona: Option.fromUndefinedOr(flow.persona) }))),
  });

const MAX_RUNS = 15;

// Runs in flight first, then the latest finished ones.
export const runRows = (status: Option.Option<DaemonStatus>): ReadonlyArray<RunEntry> =>
  Option.match(status, {
    onNone: () => [],
    onSome: (found) => [...found.active, ...found.recent.filter((run) => run.status !== 'running').map((run) => ({ ...run, parked: false }))].slice(0, MAX_RUNS),
  });

const MINUTE = 60;
const HOUR = 3600;

const spanText = (span: number) => {
  if (span < MINUTE) return `${span}s`;

  if (span < HOUR) return `${Math.round(span / MINUTE)}m`;

  return `${Math.round(span / HOUR)}h`;
};

const ago = (at: Option.Option<string>, now: DateTime.Utc) =>
  Option.match(
    Option.flatMap(at, (iso) => DateTime.make(iso)),
    {
      onNone: () => '—',
      onSome: (then) => {
        const seconds = Math.round((DateTime.toEpochMillis(then) - DateTime.toEpochMillis(now)) / 1000);
        const span = Math.abs(seconds);

        if (span < 1) return 'now';

        if (seconds > 0) return `in ${spanText(span)}`;

        return `${spanText(span)} ago`;
      },
    },
  );

const pad = (text: string, width: number) => {
  if (text.length >= width) return `${text.slice(0, Math.max(0, width - 1))}…`;

  return text.padEnd(width);
};

const percent = (value: number) => `${Math.round(value * 100)}%`.padStart(4);

const firstLine = (text: string) => text.split('\n')[0] ?? '';

const STATUS_STYLE: Readonly<Record<RunStatus, Style>> = { done: 'green', running: 'cyan', skipped: 'dim', 'needs-human': 'yellow', failed: 'red' };

const heading = (text: string): Line => [segment(text, 'bold')];

const select = (line: Line, selected: boolean): Line => {
  if (!selected) return line;

  return line.map((part) => ({ ...part, style: 'selected' }));
};

export const KEYS_MAIN = 'tab switch pane · ↑↓ select · enter log · a attach · t trigger · e flow on/off · p pause/resume · r refresh · q quit';
export const KEYS_LOG = '↑↓ scroll · end follow · a attach · esc back · q quit';

const repoState = (repo: RepoStatus) => {
  if (repo.paused) return 'paused';

  if (!repo.enabled) return 'disabled';

  return repo.status;
};

const stateStyle = (state: string): Style => {
  if (state === 'ready') return 'green';

  if (state === 'paused' || state === 'disabled') return 'yellow';

  return 'red';
};

const QUEUE_SHOWN = 3;

const queuedText = (queued: ReadonlyArray<string>) => {
  if (queued.length === 0) return 'queue empty';

  const more = onlyIf(queued.length > QUEUE_SHOWN, ['…']);

  return `${queued.length} queued: ${[...queued.slice(0, QUEUE_SHOWN), ...more].join(', ')}`;
};

const queueText = (queued: ReadonlyArray<string>, elsewhere: ReadonlyArray<string>) => {
  if (elsewhere.length === 0) return queuedText(queued);

  return `${queuedText(queued)} · ${elsewhere.length} assigned elsewhere`;
};

const plural = (count: number) => {
  if (count === 1) return '';

  return 's';
};

const runDetail = (run: RunEntry) => {
  if (run.status !== 'running') return Option.getOrElse(run.summary, () => '');

  if (run.parked) return 'waiting for a signal';

  return Option.getOrElse(run.currentStep, () => 'starting');
};

const flowTiming = (enabled: boolean, pending: boolean, next: Option.Option<string>, now: DateTime.Utc) => {
  if (pending && enabled) return segment(pad('on, pending', 14), 'yellow');

  if (pending) return segment(pad('off, pending', 14), 'yellow');

  if (enabled) return segment(`next ${pad(ago(next, now), 9)}`);

  return segment(pad('off', 14), 'dim');
};

const launchSegment = (launch: boolean, when: string) => {
  if (launch) return segment(`  room for a task (${when})`, 'dim');

  return segment(`  holding back (${when})`, 'yellow');
};

const detailStyle = (status: RunStatus): Style => {
  if (status === 'running') return 'cyan';

  return 'dim';
};

const statusView = (model: Model, status: DaemonStatus): Array<Line> => {
  const { now } = model;
  const lines: Array<Line> = [];

  lines.push([
    segment('chernabog', 'bold'),
    segment(`  daemon ${status.pid}, up ${ago(Option.some(status.startedAt), now).replace(' ago', '')}`, 'dim'),
    ...onlyIf(status.busy > 0, [segment(`  ${status.busy} step${plural(status.busy)} executing`, 'cyan')]),
    ...onlyIf(status.reloadPending, [segment('  restarting on new config when idle', 'yellow')]),
  ]);
  lines.push([]);

  lines.push(heading('Repos and flows'));
  const selectedFlow = Arr.get(flowRows(Option.some(status)), model.flowIndex);
  const labelOf = (flow: { readonly name: string; readonly persona?: string }) => `${flow.name}${Option.match(Option.fromUndefinedOr(flow.persona), { onNone: () => '', onSome: (login) => ` @${login}` })}`;
  // Wide enough for a persona's name too, within reason.
  const flowColumn = Math.min(24, Math.max(12, ...status.repos.flatMap((repo) => repo.flows.map((flow) => labelOf(flow).length + 1))));

  for (const repo of status.repos) {
    const state = repoState(repo);
    lines.push([
      segment(`  ${repo.name}`, 'bold'),
      segment(`  ${state}`, stateStyle(state)),
      ...Option.toArray(Option.map(repo.launcher, (launcher) => segment(`  launcher ${launcher}`, 'dim'))),
      ...Option.toArray(Option.map(repo.message, (message) => segment(`  ${message}`, 'dim'))),
    ]);

    for (const flow of repo.flows) {
      const persona = Option.fromUndefinedOr(flow.persona);
      const selected = model.focus === 'flows' && Option.exists(selectedFlow, (row) => row.repo === repo.name && row.flow === flow.name && samePersona(row.persona, persona));
      const enabled = flowEnabled(model, repo.name, flow);
      const timing = flowTiming(enabled, enabled !== flow.enabled, flow.next, now);
      const why = Option.filter(Option.fromUndefinedOr(flow.offReason), (reason) => !enabled && reason !== FLOW_TURNED_OFF);
      lines.push(select([segment(`    ${pad(labelOf(flow), flowColumn)}`), timing, segment(`  ${Option.getOrElse(why, () => queueText(flow.queued, flow.assignedElsewhere ?? []))}`, 'dim')], selected));
    }
  }

  lines.push([]);

  lines.push(heading('Usage'));

  if (model.usage.length === 0) lines.push([segment('  no readings yet', 'dim')]);

  for (const row of model.usage) {
    const over = row.fiveHour >= model.thresholds.fiveHourCeiling || row.sevenDay >= model.thresholds.targetEndUsage;
    const limits = `5h ${percent(row.fiveHour)} of ${Math.round(model.thresholds.fiveHourCeiling * 100)}%  week ${percent(row.sevenDay)} of ${Math.round(model.thresholds.targetEndUsage * 100)}%`;
    lines.push([segment(`  ${pad(row.account, 12)}`), segment(limits, styleIf(over, 'yellow')), launchSegment(row.launch, ago(Option.some(row.at), now))]);
  }

  lines.push([]);

  lines.push(heading('Runs'));
  const runs = runRows(Option.some(status));

  if (runs.length === 0) lines.push([segment('  none yet', 'dim')]);

  runs.forEach((run, runIndex) => {
    const title = Option.getOrElse(run.itemTitle, () => run.itemKey);
    const when = ago(Option.orElse(run.finishedAt, () => Option.some(run.startedAt)), now);

    lines.push(
      select(
        [
          segment(`  ${pad(run.status, 12)}`, STATUS_STYLE[run.status]),
          segment(`${pad(`${run.repo}/${run.flow}${Option.match(run.persona, { onNone: () => '', onSome: (login) => `@${login}` })}`, 22)} ${pad(title, 28)}`),
          segment(` ${pad(when, 8)} `, 'dim'),
          segment(firstLine(runDetail(run)), detailStyle(run.status)),
        ],
        model.focus === 'runs' && model.runIndex === runIndex,
      ),
    );
  });

  if (status.skips.length > 0) {
    lines.push([]);
    lines.push(heading('Recent skips'));

    for (const skip of status.skips.slice(0, 4)) {
      lines.push([segment(`  ${pad(`${skip.repo}/${skip.flow}`, 22)} ${firstLine(skip.reason)}`, 'dim'), segment(`  ${ago(Option.some(skip.at), now)}`, 'dim')]);
    }
  }

  return lines;
};

const mainView = (model: Model): ReadonlyArray<Line> =>
  Option.match(model.status, {
    onNone: () => [[segment(Option.getOrElse(model.error, () => 'connecting to the daemon…'), 'yellow')]],
    onSome: (status) => statusView(model, status),
  });

const logView = (model: Model): ReadonlyArray<Line> => {
  const run = Arr.findFirst(runRows(model.status), (candidate) => Option.contains(model.logRun, candidate.id));

  const header: ReadonlyArray<Line> = [
    [
      segment(Option.getOrElse(model.logRun, () => ''), 'bold'),
      ...Option.toArray(
        Option.map(run, (found) => segment(`  ${found.status}${Option.match(found.currentStep, { onNone: () => '', onSome: (step) => `: ${step}` })}`, STATUS_STYLE[found.status])),
      ),
    ],
    [],
  ];

  const room = Math.max(1, model.height - header.length - 2);
  const end = Math.max(0, model.logLines.length - model.logScroll);
  const shown = model.logLines.slice(Math.max(0, end - room), end).map((line): Line => [segment(line, styleIf(/error|failed|needs a person/i.test(line), 'red'))]);

  return [...header, ...shown];
};

const clipLine = (line: Line, width: number): Line => {
  const out: Array<Segment> = [];
  let used = 0;

  for (const part of line) {
    if (used >= width) break;

    const text = part.text.slice(0, width - used);
    out.push({ ...part, text });
    used += text.length;
  }

  return out;
};

const bodyOf = (model: Model) => {
  if (model.view === 'log') return logView(model);

  return mainView(model);
};

const keysOf = (model: Model) => {
  if (model.view === 'log') return KEYS_LOG;

  return KEYS_MAIN;
};

// The whole screen: the view, then the message and the keys on the last lines.
export const view = (model: Model): ReadonlyArray<Line> => {
  const footer: ReadonlyArray<Line> = [Option.match(model.message, { onNone: () => [], onSome: (message) => [segment(message, 'yellow')] }), [segment(keysOf(model), 'dim')]];

  const room = Math.max(0, model.height - footer.length);

  const clipped = bodyOf(model)
    .slice(0, room)
    .map((line) => clipLine(line, model.width));

  return [...clipped, ...Array.from({ length: room - clipped.length }, (): Line => []), ...footer.map((line) => clipLine(line, model.width))];
};

export const plain = (lines: ReadonlyArray<Line>) => lines.map((line) => line.map((part) => part.text).join('').trimEnd()).join('\n');
