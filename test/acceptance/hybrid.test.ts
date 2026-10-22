// The hybrid path end to end, through the daemon and tmux, with the
// human-initiated recipe: alice starts an
// issue with `chernabog start`, works on it with Claude in a session in front
// of her and finishes with `chernabog open-pr`. bob, the team's reviewer,
// asks for changes; alice's session opens again to answer them; bob approves.
// Nobody but a person merges it.

import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as Option from 'effect/Option';

import { closed, openSandbox, type Sandbox, waitFor } from './sandbox.ts';

const often = { schedule: '*/2 * * * * *' };

describe('the hybrid path', () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;

  const pull = () => Option.getOrThrow(sandbox.github.firstPull());

  beforeAll(async () => {
    sandbox = openSandbox(
      { reviewers: ['bob'], flows: { review: { agent: 'codex' }, 're-review': { agent: 'codex' } } },
      {
        github: ['alice', 'bob'],
        personas: ['alice', 'bob'],
        launcher: 'tmux',
        personaFlows: { alice: { 'address-review': often }, bob: { review: often, 're-review': often } },
        recipes: ['implement', 'review', 're-review', 'address-review', 'human-initiated'],
      },
    );
    await sandbox.runCli(['trust', 'demo']);
    daemon = sandbox.cli(['daemon']);
    await waitFor(() => existsSync(join(sandbox.home, 'daemon.sock')), 'the daemon');
  });

  afterAll(async () => {
    if ('DEBUG_DAEMON' in process.env) process.stdout.write(`${sandbox.daemonLog()}\n`);

    daemon.kill('SIGTERM');
    await closed(daemon);

    // End the sessions left open for the person to close.
    for (const pidFile of new Bun.Glob('*.pid').scanSync(join(sandbox.root, 'tmux'))) Bun.spawnSync(['kill', '-9', `-${readFileSync(join(sandbox.root, 'tmux', pidFile), 'utf8')}`]);

    await sandbox.github.stop();
  });

  test('alice starts an issue, opens its pull request from her session, answers a review in it, and bob approves without merging', async () => {
    sandbox.github.addIssue('Work it out together', []);
    const started = await sandbox.runCli(['start', '1', '--as', 'alice']);
    expect(started.output).toContain('Opening the session in tmux');
    expect(started.code).toBe(0);
    expect(sandbox.tmuxCalls().some((call) => call.startsWith('attach-session'))).toBe(true);

    await waitFor(() => /finished [\da-f-]{36} \(demo\/re-review .*\): done/.test(sandbox.daemonLog()), 'the re-review to approve', 120_000);

    expect(pull().author).toBe('alice');
    expect(pull().labels).toContain('hybrid');
    expect(pull().labels).not.toContain('auto:ship');
    expect(sandbox.github.reviewsOf(pull().number).map((review) => `${review.author} ${review.state}`)).toEqual(['bob CHANGES_REQUESTED', 'bob APPROVED']);
    expect(sandbox.github.merges).toEqual([]);

    // One Claude session, under tmux, with alice: opened by start, finished by open-pr, then reopened to weigh the review and answer it.
    const claude = sandbox.claudeCalls();
    const sessions = claude.filter((call) => !call.startsWith('open-pr'));
    expect(sessions.map((call) => call.split(' ').slice(0, 1).concat(call.split(' ')[2] ?? '').join(' '))).toEqual(['start interactive', 'resume interactive', 'resume interactive']);
    expect(new Set(sessions.map((call) => call.split(' ')[1])).size).toBe(1);
    expect(claude.some((call) => call.startsWith('open-pr') && call.includes('exited 0'))).toBe(true);

    expect(sandbox.daemonLog()).toMatch(/started [\da-f-]{36} \(demo\/human-initiated issue-1 as alice\)/);
    expect(sandbox.daemonLog()).toMatch(/started [\da-f-]{36} \(demo\/address-review pr-\d+-changes-1 as alice\)/);
    expect(sandbox.daemonLog()).toMatch(/finished [\da-f-]{36} \(demo\/re-review pr-\d+-review-2 as bob\): done: #\d+ approved; a person merges/);
    expect(sandbox.github.issue(1).labels).not.toContain('auto:in-progress');
  }, 150_000);
});

describe('a repo without a human-initiated flow', () => {
  test('refuses chernabog start, pointing at the recipe that bakes one', async () => {
    const sandbox = openSandbox();
    await sandbox.runCli(['trust', 'demo']);
    const daemon = sandbox.cli(['daemon']);
    await waitFor(() => existsSync(join(sandbox.home, 'daemon.sock')), 'the daemon');
    sandbox.github.addIssue('Work it out together', []);

    const refused = await sandbox.runCli(['start', '1']);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('demo has no human-initiated flow in .chernabog/flows/');
    expect(refused.output).toContain('chernabog recipes add human-initiated bakes it: https://dataquail.github.io/chernabog/recipes/human-initiated/');

    daemon.kill('SIGTERM');
    await closed(daemon);
    await sandbox.github.stop();
  }, 60_000);
});
