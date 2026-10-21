// What each key does: a new model, and the action the app carries out.

import * as Arr from 'effect/Array';
import * as Option from 'effect/Option';

import { samePersona } from '../persona.ts';
import { flowEnabled, type FlowRow, flowRows, type Model, type RunEntry, runRows } from './view.ts';

export type Key = { readonly name: string; readonly ctrl?: boolean };

export type Action =
  | { readonly kind: 'none' }
  | { readonly kind: 'quit' }
  | { readonly kind: 'refresh' }
  | { readonly kind: 'open-log'; readonly run: string }
  | { readonly kind: 'attach'; readonly run: string }
  | { readonly kind: 'trigger'; readonly repo: string; readonly flow: string; readonly persona: Option.Option<string> }
  | { readonly kind: 'pause'; readonly repo: string; readonly paused: boolean }
  | { readonly kind: 'toggle-flow'; readonly repo: string; readonly flow: string; readonly persona: Option.Option<string>; readonly enabled: boolean };

export type Updated = { readonly model: Model; readonly action: Action };

const none: Action = { kind: 'none' };
const clamp = (value: number, length: number) => Math.max(0, Math.min(value, Math.max(0, length - 1)));

const otherPane = (focus: Model['focus']): Model['focus'] => {
  if (focus === 'flows') return 'runs';

  return 'flows';
};

// Moves the selection in the focused pane.
const move = (model: Model, flows: ReadonlyArray<FlowRow>, runs: ReadonlyArray<RunEntry>, step: number): Updated => {
  if (model.focus === 'flows') return { model: { ...model, flowIndex: clamp(model.flowIndex + step, flows.length) }, action: none };

  return { model: { ...model, runIndex: clamp(model.runIndex + step, runs.length) }, action: none };
};

const selectedRepoName = (model: Model, flows: ReadonlyArray<FlowRow>, selectedRun: Option.Option<RunEntry>) => {
  if (model.focus === 'flows') return Option.map(Arr.get(flows, model.flowIndex), (flow) => flow.repo);

  return Option.map(selectedRun, (run) => run.repo);
};

const updateLog = (model: Model, cleared: Model, key: Key): Updated => {
  const page = Math.max(1, model.height - 6);
  const top = Math.max(0, model.logLines.length - 1);

  switch (key.name) {
    case 'escape':
    case 'backspace':
    case 'h':
    case 'left':
      return { model: { ...cleared, view: 'main', logRun: Option.none(), logLines: [], logScroll: 0 }, action: none };
    case 'up':
    case 'k':
      return { model: { ...cleared, logScroll: Math.min(model.logScroll + 1, top) }, action: none };
    case 'down':
    case 'j':
      return { model: { ...cleared, logScroll: Math.max(0, model.logScroll - 1) }, action: none };
    case 'pageup':
      return { model: { ...cleared, logScroll: Math.min(model.logScroll + page, top) }, action: none };
    case 'pagedown':
      return { model: { ...cleared, logScroll: Math.max(0, model.logScroll - page) }, action: none };
    case 'end':
    case 'g':
      return { model: { ...cleared, logScroll: 0 }, action: none };
    case 'a':
      return Option.match(model.logRun, {
        onNone: () => ({ model, action: none }),
        onSome: (run) => ({ model: cleared, action: { kind: 'attach', run } }),
      });
    default:
      return { model, action: none };
  }
};

export const update = (model: Model, key: Key): Updated => {
  const flows = flowRows(model.status);
  const runs = runRows(model.status);
  const selectedRun = Arr.get(runs, model.runIndex).pipe(Option.filter(() => model.focus === 'runs'));
  const cleared: Model = { ...model, message: Option.none() };

  if ((key.name === 'c' && key.ctrl === true) || key.name === 'q') return { model, action: { kind: 'quit' } };

  if (key.name === 'r') return { model: cleared, action: { kind: 'refresh' } };

  if (model.view === 'log') return updateLog(model, cleared, key);

  switch (key.name) {
    case 'tab':
      return { model: { ...cleared, focus: otherPane(model.focus) }, action: none };
    case 'up':
    case 'k':
      return move(cleared, flows, runs, -1);
    case 'down':
    case 'j':
      return move(cleared, flows, runs, 1);
    case 'return':
    case 'enter':
    case 'l':
    case 'right':
      return Option.match(selectedRun, {
        onNone: () => ({ model: { ...cleared, message: Option.some('select a run first (tab to the runs)') }, action: none }),
        onSome: (run) => ({ model: { ...cleared, view: 'log', logRun: Option.some(run.id), logLines: [], logScroll: 0 }, action: { kind: 'open-log', run: run.id } }),
      });
    case 'a':
      return Option.match(selectedRun, {
        onNone: () => ({ model: { ...cleared, message: Option.some('select a run to attach to (tab to the runs)') }, action: none }),
        onSome: (run) => ({ model: cleared, action: { kind: 'attach', run: run.id } }),
      });
    case 't':
      return Option.match(
        Arr.get(flows, model.flowIndex).pipe(Option.filter(() => model.focus === 'flows')),
        {
          onNone: () => ({ model: { ...cleared, message: Option.some('select a flow to trigger (tab to the flows)') }, action: none }),
          onSome: (flow) => ({ model: cleared, action: { kind: 'trigger', repo: flow.repo, flow: flow.flow, persona: flow.persona } }),
        },
      );
    case 'e': {
      const flow = Arr.get(flows, model.flowIndex).pipe(Option.filter(() => model.focus === 'flows'));

      const status = Option.flatMap(flow, (row) =>
        Option.flatMap(model.status, (found) => Arr.findFirst(found.repos, (repo) => repo.name === row.repo)).pipe(Option.flatMap((repo) => Arr.findFirst(repo.flows, (candidate) => candidate.name === row.flow && samePersona(Option.fromUndefinedOr(candidate.persona), row.persona)))),
      );

      return Option.match(Option.all([flow, status]), {
        onNone: () => ({ model: { ...cleared, message: Option.some('select a flow to turn on or off (tab to the flows)') }, action: none }),
        onSome: ([row, found]) => ({ model: cleared, action: { kind: 'toggle-flow', repo: row.repo, flow: row.flow, persona: row.persona, enabled: !flowEnabled(model, row.repo, found) } }),
      });
    }

    case 'p': {
      const name = selectedRepoName(model, flows, Arr.get(runs, model.runIndex));
      const repo = Option.flatMap(model.status, (status) => Arr.findFirst(status.repos, (candidate) => Option.contains(name, candidate.name)));

      return Option.match(repo, {
        onNone: () => ({ model, action: none }),
        onSome: (found) => ({ model: cleared, action: { kind: 'pause', repo: found.name, paused: !found.paused } }),
      });
    }

    default:
      return { model, action: none };
  }
};
