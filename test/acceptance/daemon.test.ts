// The daemon end to end: trust, scheduled ticks, gates, the socket the CLI uses.

import { type ChildProcess, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
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
    await waitFor(() => /finished [\da-f-]{36} \(demo\/implement issue-1\): done/.test(sandbox.daemonLog()), 'the daemon to record the run as done');
    const { output } = await sandbox.runCli(['status']);
    expect(output).toMatch(/done\s+[\da-f]{8}\s+demo\/implement issue-1/);
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

  test("restarts on an edit to the repo's entry in machine config, and a flow turned off there starts nothing", async () => {
    sandbox.editMachine((document) => {
      document.setIn(['repos', 0, 'flows', 'implement', 'enabled'], false);
    });
    expect(await daemonExit).toBe(75);
    expect(sandbox.daemonLog()).toContain('enrolled repos changed; restarting on them when idle');
    await startDaemon();
    expect((await sandbox.runCli(['status'])).output).toContain('  implement: off');
    await waitFor(() => sandbox.daemonLog().includes('demo/implement: skipped: flow turned off'), 'a tick of the flow turned off');
  }, 45_000);

  test('with assignee: [@me, none], leaves an issue assigned to someone else to their machine', async () => {
    const issue = sandbox.github.addIssue('Assigned to alice', ['auto:eligible'], 'Do the thing.', ['alice']);
    sandbox.editMachine((document) => {
      document.setIn(['repos', 0, 'flows', 'implement'], document.createNode({ assignee: ['@me', 'none'] }));
    });
    expect(await daemonExit).toBe(75);
    await startDaemon();
    await waitFor(() => sandbox.daemonLog().includes(`demo/implement: skipped: only work for others: issue-${issue} (assignee: alice)`), 'a tick that leaves the issue to alice');
    expect((await sandbox.runCli(['status'])).output).toContain(`assigned elsewhere: issue-${issue} (assignee: alice)`);
    expect(sandbox.github.issue(issue).labels).toContain('auto:eligible');
  }, 45_000);

  test('picks up a repo enrolled while it runs, untrusted until trust, without a manual restart', async () => {
    // A second repo whose origin path reads as github.com/dataquail/other, so enroll takes it for a GitHub repo.
    const origin = join(sandbox.root, 'github.com', 'dataquail', 'other.git');
    const other = join(sandbox.root, 'other');
    mkdirSync(join(sandbox.root, 'github.com', 'dataquail'), { recursive: true });
    execFileSync('git', ['clone', '-q', '--bare', sandbox.bare, origin]);
    execFileSync('git', ['clone', '-q', origin, other]);

    const enrolled = await sandbox.runCli(['enroll', other, '--flows', 'implement']);
    expect(enrolled.output).toContain('added dataquail/other');
    expect(await daemonExit).toBe(75);
    expect(sandbox.daemonLog()).toContain('enrolled repos changed; restarting on them when idle');
    await startDaemon();
    expect((await sandbox.runCli(['status'])).output).toContain('other (dataquail/other): untrusted — not trusted yet; run chernabog trust other');

    await sandbox.runCli(['trust', 'other']);
    expect(await daemonExit).toBe(75);
    await startDaemon();
    expect((await sandbox.runCli(['status'])).output).toContain('other (dataquail/other): ready');
  }, 45_000);
});
