import { HEADLESS, printJson } from '@chernabog/sdk';
import { expect, test } from 'bun:test';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';

import { effect, effectAtHomeWith } from '../test/effect-test.ts';
import { fixture } from '../test/fixtures.ts';
import { execTestLayer } from './Exec.ts';
import { decideLaunch, type GateConfig, isExpired, keychainServiceFor, parseUsageReading, refreshByRunningClaude, UsageResponse } from './usage-gate.ts';

const config: GateConfig = {
  targetEndUsage: 0.95,
  taskCostEstimate: 0.04,
  fiveHourCeiling: 0.4,
  humanRatePerHour: 0.005,
};

const recorded = fixture('usage.json', UsageResponse).pipe(Effect.flatMap(parseUsageReading));

type Usage = { readonly fiveHour?: number; readonly sevenDay?: number; readonly sevenDayResetsAt?: string };

const reading = (usage: Usage) =>
  parseUsageReading({
    five_hour: { utilization: usage.fiveHour ?? 10, resets_at: '2026-10-15T21:00:00Z' },
    seven_day: { utilization: usage.sevenDay ?? 20, resets_at: usage.sevenDayResetsAt ?? '2026-10-18T20:00:00Z' },
  });

const now = DateTime.makeUnsafe('2026-10-15T20:00:00Z');

const launches = (usage: Usage) => reading(usage).pipe(Effect.map((parsed) => decideLaunch(parsed, config, now)));

test('the personal config dir reads its own keychain item, the one Claude Code names after its path', () => {
  expect(keychainServiceFor(Option.some('/Users/dev/.claude-personal'))).toBe('Claude Code-credentials-402de754');
});

effect(
  'the recorded reading, early in the week with little used, launches',
  () => Effect.gen(function* () {
    const decision = decideLaunch(yield* recorded, config, now);
    expect(decision.launch).toBe(true);
  }),
);

effect(
  'utilization arrives as a percentage and is compared as a fraction',
  () => Effect.gen(function* () {
    expect((yield* recorded).fiveHour.used).toBe(0.01);
  }),
);

effect(
  'five-hour usage at the ceiling skips, leaving room for interactive work',
  () => Effect.gen(function* () {
    const decision = yield* launches({ fiveHour: 40 });
    expect(decision.launch).toBe(false);
    expect(decision.reason).toMatch(/five-hour/);
  }),
);

effect(
  'weekly headroom below one task skips',
  () => Effect.gen(function* () {
    // 0.95 − 0.80 − 0.005 × 72h = −0.21
    expect((yield* launches({ sevenDay: 80 })).launch).toBe(false);
  }),
);

effect(
  'close to the weekly reset, what is left gets used',
  () => Effect.gen(function* () {
    // 0.95 − 0.80 − 0.005 × 2h = 0.14
    expect((yield* launches({ sevenDay: 80, sevenDayResetsAt: '2026-10-15T22:00:00Z' })).launch).toBe(true);
  }),
);

effect(
  'headroom exactly equal to the estimate launches despite float error',
  () => Effect.gen(function* () {
    // 0.95 − 0.55 − 0.005 × 72h = 0.04
    expect((yield* launches({ sevenDay: 55 })).launch).toBe(true);
  }),
);

effect(
  'a reading without a usable window fails loudly',
  () => Effect.gen(function* () {
    const failed = yield* Effect.flip(reading({ sevenDayResetsAt: 'whenever' }));
    expect(failed.message).toMatch(/seven_day/);
  }),
);

test('a token past its expiry is expired; one without an expiry is trusted', () => {
  const nowMs = DateTime.toEpochMillis(now);
  expect(isExpired({ accessToken: 'x', expiresAt: nowMs - 1 }, now)).toBe(true);
  expect(isExpired({ accessToken: 'x', expiresAt: nowMs + 60_000 }, now)).toBe(false);
  expect(isExpired({ accessToken: 'x' }, now)).toBe(false);
});

const execCalls: Array<string> = [];
let refreshStarted = false;

// The keychain's token turns fresh once a tmux session has started.
const effectRefreshing = effectAtHomeWith(
  execTestLayer((command, args) => {
    execCalls.push([command, ...args.slice(0, 2)].join(' '));

    if (command === 'tmux' && args[0] === 'new-session') refreshStarted = true;

    let expiresAt = 1;

    if (refreshStarted) expiresAt = 4102444800000;

    if (command === 'security') return Option.some({ exitCode: 0, stdout: printJson({ claudeAiOauth: { accessToken: 'token', expiresAt } }), stderr: '' });

    return Option.some({ exitCode: 0, stdout: '', stderr: '' });
  }),
);

effectRefreshing('under a launcher, an expired token refreshes in a short interactive session, never claude -p', () =>
  Effect.gen(function* () {
    const account = { name: 'personal', configDir: Option.some('/Users/dev/.claude-personal'), expectedEmail: Option.none<string>() };
    yield* refreshByRunningClaude(account, { launcher: { ...HEADLESS, name: 'tmux', from: 'machine config' }, cwd: '/code/demo' });
    expect(execCalls).toContain('tmux new-session -d');
    expect(execCalls).toContain('tmux kill-session -t');
    expect(execCalls.filter((call) => call.startsWith('claude'))).toEqual([]);
  }),
);
