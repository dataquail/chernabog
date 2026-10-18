// The daemon end to end: trust, scheduled ticks, gates, the socket the CLI uses.

import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as Option from 'effect/Option';

import { openSandbox, type Sandbox, waitFor } from './sandbox.ts';

describe('the daemon', () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;
  let daemonExit: Promise<number> = Promise.resolve(0);
  let daemonOutput = '';
  const socket = () => join(sandbox.home, 'daemon.sock');

  const startDaemon = async () => {
    const started = sandbox.cli(['daemon']);
    daemon = started;
    let output = '';

    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      daemonOutput += chunk.toString();
    };

    started.stdout.on('data', collect);
    started.stderr.on('data', collect);

    daemonExit = new Promise((resolve) => {
      started.on('close', (code) => {
        resolve(code ?? -1);
      });
    });

    await waitFor(() => existsSync(socket()), `the daemon's socket (${output})`);
  };

  const stopDaemon = async () => {
    if (Option.isNone(Option.fromNullishOr(daemon.exitCode))) daemon.kill('SIGTERM');

    await daemonExit;
  };

  beforeAll(() => {
    // Every two seconds, so the test sees ticks without waiting a minute.
    sandbox = openSandbox({ flows: { implement: { schedule: '*/2 * * * * *' } } });
  });

  afterAll(async () => {
    if ('DEBUG_DAEMON' in process.env) process.stdout.write(`${sandbox.daemonLog()}\n${daemonOutput}\n`);

    await stopDaemon();
    await sandbox.github.stop();
  });

  test('starts no runs in a repo whose .chernabog/ is not trusted yet', async () => {
    sandbox.github.addIssue('Scheduled work', ['auto:eligible']);
    await startDaemon();
    const { output } = await sandbox.runCli(['status']);
    expect(output).toContain('demo (dataquail/demo): untrusted — not trusted yet; run chernabog trust demo');
    expect(sandbox.github.pulls.size).toBe(0);
  }, 30_000);

  test('trust shows what it trusts, and the daemon restarts on it', async () => {
    const { output } = await sandbox.runCli(['trust', 'demo']);
    expect(output).toContain('first trust; .chernabog/ holds:');
    expect(output).toContain('flows/implement.ts');
    expect(await daemonExit).toBe(75);
    await startDaemon();
    expect((await sandbox.runCli(['status'])).output).toContain('demo (dataquail/demo): ready');
  }, 30_000);

  test('runs the flow when its schedule comes due, through the gate, to a hand-off', async () => {
    await waitFor(() => [...sandbox.github.pulls.values()].some((pull) => pull.labels.includes('auto:needs-review')), 'a scheduled run to hand off', 45_000);
    await waitFor(() => /finished demo\.implement\.issue-1\.\S+: done/.test(sandbox.daemonLog()), 'the daemon to record the run as done');
    const { output } = await sandbox.runCli(['status']);
    expect(output).toMatch(/done\s+demo\.implement\.issue-1/);
  }, 60_000);

  test('the usage gate holds a run back and says why', async () => {
    sandbox.github.setUsage(90, 10);
    sandbox.github.addIssue('Over budget', ['auto:eligible']);
    await waitFor(() => /usage gate: five-hour usage 0\.9 is at or over/.test(sandbox.daemonLog()), 'the gate to skip');
    expect(sandbox.github.pulls.size).toBe(1);
    sandbox.github.setUsage(5, 10);
  }, 30_000);

  test('a paused repo starts nothing, and resumes', async () => {
    await sandbox.runCli(['pause', 'demo']);
    await waitFor(() => sandbox.daemonLog().includes('demo/implement: skipped: paused'), 'a paused tick');
    expect(sandbox.github.pulls.size).toBe(1);
    await sandbox.runCli(['resume', 'demo']);
    await waitFor(() => sandbox.github.pulls.size === 2, 'the queued issue to run after resuming', 45_000);
  }, 60_000);

  test('run goes through the daemon, which holds the engine', async () => {
    const { output } = await sandbox.runCli(['run', 'implement', '--repo', 'demo', '--from-checkout']);
    expect(output).toContain('is held by');
    const viaDaemon = await sandbox.runCli(['run', 'implement', '--repo', 'demo']);
    expect(viaDaemon.output).toContain('nothing to start');
  }, 30_000);
});
