import { HEADLESS, printJson } from '@chernabog/sdk';
import { describe, expect, test } from 'bun:test';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import * as Schema from 'effect/Schema';

import { attachCommand } from '../src/agents.ts';
import { LaunchRecord, sessionFiles } from '../src/agents/session-files.ts';
import { rememberSession } from '../src/agents/sessions.ts';
import { Home } from '../src/config.ts';
import { execTestLayer } from '../src/Exec.ts';
import type { DaemonStatus } from '../src/protocol.ts';
import type { RunRow, RunStatus } from '../src/state.ts';
import { initialModel, readUsage } from '../src/tui/app.ts';
import { update } from '../src/tui/update.ts';
import { type Model, plain, view } from '../src/tui/view.ts';
import { effectAtHome, effectAtHomeWith } from './effect-test.ts';

const now = DateTime.makeUnsafe('2026-10-17T12:00:00Z');
const minutes = (offset: number) => DateTime.formatIso(DateTime.add(now, { minutes: offset }));

const finishedSummary = (status: RunStatus) => {
  if (status === 'done') return '#7: ready for review';

  return 'CI still red';
};

const run = (id: string, status: RunStatus): RunRow => {
  const running = status === 'running';

  return {
    id,
    repo: 'goodbones',
    flow: Option.getOrElse(Option.as(Option.liftPredicate(id, (known) => known.includes('review')), 'review'), () => 'implement'),
    itemKey: 'issue-7',
    itemTitle: Option.some('Fix the parser'),
    itemUrl: Option.none(),
    executionId: Option.some('x'),
    status,
    currentStep: Option.as(Option.liftPredicate(status, () => running), 'implement'),
    summary: Option.map(Option.liftPredicate(status, () => !running), finishedSummary),
    startedAt: minutes(-30),
    finishedAt: Option.as(Option.liftPredicate(status, () => !running), minutes(-5)),
  };
};

const status: DaemonStatus = {
  pid: 4242,
  startedAt: minutes(-120),
  busy: 1,
  reloadPending: false,
  repos: [
    {
      name: 'goodbones',
      slug: 'dataquail/goodbones',
      status: 'ready',
      message: Option.none(),
      paused: false,
      enabled: true,
      tree: Option.some('abc'),
      launcher: Option.some('orca (machine config)'),
      flows: [
        { name: 'implement', schedule: '17 * * * *', next: Option.some(minutes(17)), lastTick: Option.some(minutes(-43)), enabled: true, queued: ['issue-9 Add a flag'] },
        { name: 'review', schedule: '17 * * * *', next: Option.some(minutes(17)), lastTick: Option.some(minutes(-43)), enabled: true, queued: [] },
      ],
    },
    {
      name: 'hexagon',
      slug: 'dataquail/hexagon',
      status: 'untrusted',
      message: Option.some('not trusted yet; run chernabog trust hexagon'),
      paused: false,
      enabled: true,
      tree: Option.none(),
      launcher: Option.none(),
      flows: [],
    },
  ],
  active: [
    { ...run('goodbones.implement.issue-7.1', 'running'), parked: false },
    { ...run('goodbones.review.pr-8.1', 'running'), parked: true },
  ],
  recent: [run('goodbones.implement.issue-7.1', 'running'), run('goodbones.implement.issue-5.1', 'needs-human')],
  skips: [{ repo: 'goodbones', flow: 'implement', itemKey: Option.none(), reason: 'usage gate: five-hour usage 0.5 is at or over the 0.4 ceiling', at: minutes(-43) }],
};

const model = (overrides: Partial<Model> = {}): Model => ({ ...initialModel(140, 40, now), status: Option.some(status), now, ...overrides });

describe('the main view', () => {
  const screen = plain(view(model({ usage: [{ account: 'personal', fiveHour: 0.12, sevenDay: 0.5, launch: true, reason: '', at: minutes(-43) }] })));

  test('shows each repo, its flows, their next tick and their queue', () => {
    expect(screen).toContain('goodbones  ready  launcher orca (machine config)');
    expect(screen).toMatch(/implement\s+next in 17m\s+1 queued: issue-9 Add a flag/);
    expect(screen).toContain('hexagon  untrusted  not trusted yet; run chernabog trust hexagon');
  });

  test('shows account usage against its thresholds', () => {
    expect(screen).toContain('personal    5h  12% of 40%  week  50% of 95%  room for a task (43m ago)');
  });

  test('shows runs in flight with their current step, and waiting ones as waiting', () => {
    expect(screen).toMatch(/running\s+goodbones\/implement\s+Fix the parser\s+30m ago\s+implement/);
    expect(screen).toMatch(/running\s+goodbones\/review\s+Fix the parser\s+30m ago\s+waiting for a signal/);
    expect(screen).toMatch(/needs-human\s+goodbones\/implement .* CI still red/);
  });

  test('says why ticks were skipped, and fits the terminal', () => {
    expect(screen).toContain('usage gate: five-hour usage 0.5 is at or over the 0.4 ceiling');
    const lines = view(model({ width: 50, height: 12 }));
    expect(lines).toHaveLength(12);
    expect(plain(lines).split('\n').every((line) => line.length <= 50)).toBe(true);
  });

  test("says why a flow is off when it isn't simply turned off", () => {
    const notRunner = { ...status, repos: status.repos.map((repo) => ({ ...repo, flows: repo.flows.map((flow) => ({ ...flow, enabled: false, offReason: 'not a runner (runners: alice; this machine is bob)' })) })) };
    expect(plain(view(model({ status: Option.some(notRunner) })))).toMatch(/implement\s+off\s+not a runner \(runners: alice; this machine is bob\)/);
  });

  test('counts the work it left for other machines', () => {
    const elsewhere = { ...status, repos: status.repos.map((repo) => ({ ...repo, flows: repo.flows.map((flow) => ({ ...flow, assignedElsewhere: ['issue-4 (alice)', 'issue-5 (bob)'] })) })) };
    expect(plain(view(model({ status: Option.some(elsewhere) })))).toMatch(/implement\s+next in 17m\s+1 queued: issue-9 Add a flag · 2 assigned elsewhere/);
  });

  test('without the daemon, it says so', () => {
    expect(plain(view(model({ status: Option.none(), error: Option.some('the daemon is not running. Retrying…') })))).toContain('the daemon is not running');
  });
});

describe('keys', () => {
  test('enter opens the selected run’s log, and esc comes back', () => {
    const opened = update(model({ runIndex: 1 }), { name: 'return' });
    expect(opened.action).toEqual({ kind: 'open-log', run: 'goodbones.review.pr-8.1' });
    expect(opened.model.view).toBe('log');
    expect(update(opened.model, { name: 'escape' }).model.view).toBe('main');
  });

  test('a attaches to the selected run, t triggers the selected flow, p pauses its repo', () => {
    expect(update(model(), { name: 'a' }).action).toEqual({ kind: 'attach', run: 'goodbones.implement.issue-7.1' });
    const onFlows = update(model(), { name: 'tab' }).model;
    const down = update(onFlows, { name: 'down' }).model;
    expect(update(down, { name: 't' }).action).toEqual({ kind: 'trigger', repo: 'goodbones', flow: 'review' });
    expect(update(down, { name: 'p' }).action).toEqual({ kind: 'pause', repo: 'goodbones', paused: true });
  });

  test('e turns the selected flow off or on, from what was last turned here until the daemon restarts on it', () => {
    const onFlows = update(model(), { name: 'tab' }).model;
    expect(update(onFlows, { name: 'e' }).action).toEqual({ kind: 'toggle-flow', repo: 'goodbones', flow: 'implement', enabled: false });
    const pending = { ...onFlows, pendingFlows: { 'goodbones/implement': false } };
    expect(update(pending, { name: 'e' }).action).toEqual({ kind: 'toggle-flow', repo: 'goodbones', flow: 'implement', enabled: true });
    expect(plain(view(pending))).toMatch(/implement\s+off, pending/);
    expect(update(model(), { name: 'e' }).action).toEqual({ kind: 'none' });
  });

  test('selection stays within the list', () => {
    let current = model();

    for (let press = 0; press < 10; press++) current = update(current, { name: 'down' }).model;
    expect(current.runIndex).toBe(2);
  });

  test('the log follows its end until scrolled, and shows the newest lines that fit', () => {
    const lines = Array.from({ length: 100 }, (_, index) => `line ${index}`);
    const log = model({ view: 'log', logRun: Option.some('goodbones.implement.issue-7.1'), logLines: lines, height: 10 });
    expect(plain(view(log))).toContain('line 99');
    const scrolled = update(log, { name: 'up' }).model;
    expect(plain(view(scrolled))).not.toContain('line 99');
    expect(plain(view(update(scrolled, { name: 'end' }).model))).toContain('line 99');
  });

  test('q quits', () => {
    expect(update(model(), { name: 'q' }).action).toEqual({ kind: 'quit' });
  });
});

const window = (utilization: number) => ({ utilization, resets_at: minutes(600) });

effectAtHome("usage comes from the latest line of each account's usage log", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { root } = yield* Home;

    const lines = [
      printJson({ at: minutes(-90), five_hour: window(1), seven_day: window(2), launch: true, reason: 'old' }),
      printJson({ at: minutes(-30), five_hour: window(45), seven_day: window(60), launch: false, reason: 'five-hour usage high' }),
    ];

    yield* fs.writeFileString(`${root}/usage-personal.jsonl`, lines.join('\n'));
    expect(yield* readUsage).toEqual([{ account: 'personal', fiveHour: 0.45, sevenDay: 0.6, launch: false, reason: 'five-hour usage high', at: minutes(-30) }]);
  }),
);

// tmux answers has-session for the sessions in `tmuxSessions`.
const tmuxSessions = new Set<string>();

const effectWithTmux = effectAtHomeWith(execTestLayer((command, args) => Option.some({ exitCode: Number(!(command === 'tmux' && tmuxSessions.has(args.at(-1) ?? ''))), stdout: '', stderr: '' })));

const account = { name: 'personal', configDir: Option.some('/Users/dev/.claude-personal'), expectedEmail: Option.none<string>(), oauthTokenEnv: Option.none<string>(), usageGate: 'usage' as const };

effectWithTmux("attach opens each agent's own interactive UI on the run's session, in its worktree", () =>
  Effect.gen(function* () {
    const at = DateTime.formatIso(now);
    const claude = yield* attachCommand({ adapter: 'claude', sessionId: 'abc', cwd: '/wt', account, at });
    yield* rememberSession('codex', 'abc', 'thread-1');
    const codex = yield* attachCommand({ adapter: 'codex', sessionId: 'abc', cwd: '/wt', account: { ...account, configDir: Option.some('/Users/dev/.codex') }, at });
    expect([claude.command, ...claude.args]).toEqual(['claude', '--resume', 'abc']);
    expect(Record.get(claude.env, 'CLAUDE_CONFIG_DIR')).toEqual(Option.some('/Users/dev/.claude-personal'));
    expect([codex.command, ...codex.args]).toEqual(['codex', 'resume', 'thread-1']);
    expect(Record.get(codex.env, 'CODEX_HOME')).toEqual(Option.some('/Users/dev/.codex'));
  }),
);

effectWithTmux('attach brings up a session still running under tmux, and resumes it once it has ended', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = sessionFiles((yield* Home).root, 'abc');
    const at = DateTime.formatIso(now);
    yield* fs.makeDirectory(files.dir, { recursive: true });
    yield* fs.writeFileString(files.launch, yield* Schema.encodeEffect(LaunchRecord)({ launcher: { ...HEADLESS, name: 'tmux', from: 'machine config' }, handle: 'chernabog-abc', at }));
    const record = { adapter: 'claude', sessionId: 'abc', cwd: '/wt', account, at };
    tmuxSessions.add('=chernabog-abc');
    const live = yield* attachCommand(record);
    tmuxSessions.clear();
    const ended = yield* attachCommand(record);
    expect([live.command, ...live.args]).toEqual(['tmux', 'attach-session', '-t', '=chernabog-abc']);
    expect([ended.command, ...ended.args]).toEqual(['claude', '--resume', 'abc']);
  }),
);
