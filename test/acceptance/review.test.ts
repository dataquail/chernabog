// The review loop end to end, through the daemon: a Claude-written pull request
// gets a Codex review, a fix, and a second review, without anyone stepping in.

import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

import { closed, openSandbox, type Sandbox, waitFor } from './sandbox.ts';

const CreatedPull = Schema.Struct({ number: Schema.Finite });

describe('the review loop', () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;

  const pull = () => {
    const first = sandbox.github.firstPull();

    if (Option.isNone(first)) throw new Error('no pull request yet');

    return first.value;
  };

  beforeAll(async () => {
    const often = { schedule: '*/2 * * * * *' };
    sandbox = openSandbox({ flows: { implement: often, review: { ...often, agent: 'codex' }, fix: often } });
    await sandbox.runCli(['trust', 'demo']);
    daemon = sandbox.cli(['daemon']);
    await waitFor(() => existsSync(join(sandbox.home, 'daemon.sock')), 'the daemon');
  });

  afterAll(async () => {
    if ('DEBUG_DAEMON' in process.env) process.stdout.write(`${sandbox.daemonLog()}\n`);

    daemon.kill('SIGTERM');
    await closed(daemon);
    await sandbox.github.stop();
  });

  test('Claude implements, Codex requests changes, Claude fixes in the same session, Codex approves', async () => {
    sandbox.github.addIssue('Reviewed work', ['auto:eligible']);
    await waitFor(() => Option.exists(sandbox.github.firstPull(), (first) => first.labels.includes('auto:approved')), 'the pull request to be approved', 60_000);

    const [changes, approval] = sandbox.github.reviewsOf(pull().number);
    expect(sandbox.github.reviewsOf(pull().number)).toHaveLength(2);
    expect(changes.body).toContain('Changes requested by codex');
    expect(changes.comments[0]).toEqual({ path: 'README.md', line: 1, side: 'RIGHT', body: 'Mention the change here.' });
    expect(approval.body).toContain('Approved by codex');
    expect(approval.commit_id).not.toBe(changes.commit_id);

    // Claude wrote it and fixed it, resuming its own session; Codex only reviewed.
    const claude = sandbox.claudeCalls();
    expect(claude.map((call) => call.split(' ')[0])).toEqual(['start', 'resume']);
    const [start = '', resume = ''] = claude;
    expect(resume.split(' ')[1]).toBe(start.split(' ')[1]);
    expect(sandbox.codexCalls()).toHaveLength(2);
    expect(pull().labels).not.toContain('auto:changes-requested');
    expect(pull().labels).not.toContain('auto:needs-review');
  }, 90_000);

  test('a merge ends the review run and removes the worktrees', async () => {
    sandbox.github.closePull(pull().number);
    await waitFor(() => /finished [\da-f-]{36} \(demo\/review pr-\d+\): done: #\d+ closed; worktrees removed/.test(sandbox.daemonLog()), 'the review run to clean up', 30_000);
    expect(existsSync(join(sandbox.home, 'worktrees/demo/auto-issue-1'))).toBe(false);
    expect(existsSync(join(sandbox.home, 'worktrees/demo/review-pr-2'))).toBe(false);
  }, 60_000);
});

describe('a pull request nobody answers', () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;

  beforeAll(() => {
    sandbox = openSandbox({ flows: { review: { schedule: '*/2 * * * * *', agent: 'codex' }, fix: { enabled: false } }, limits: { staleAfter: '3 seconds' } });
  });

  afterAll(async () => {
    daemon.kill('SIGTERM');
    await closed(daemon);
    await sandbox.github.stop();
  });

  test('goes stale when no push comes before the timeout', async () => {
    await sandbox.runCli(['trust', 'demo']);
    sandbox.git(sandbox.checkout, 'checkout', '-qb', 'feature');
    sandbox.git(sandbox.checkout, 'commit', '-q', '--allow-empty', '-m', 'feat: by a person');
    sandbox.git(sandbox.checkout, 'push', '-q', 'origin', 'feature');

    const response = await fetch(`${sandbox.github.url}/repos/dataquail/demo/pulls`, {
      method: 'POST',
      body: JSON.stringify({ head: 'feature', base: 'main', title: 'feat: by a person', body: '' }),
    });

    const { number } = Schema.decodeUnknownSync(CreatedPull)(await response.json());
    sandbox.github.pull(number).labels.push('auto:needs-review');
    daemon = sandbox.cli(['daemon']);

    await waitFor(() => sandbox.github.pull(number).labels.includes('auto:stale'), 'the pull request to go stale', 45_000);
    expect(sandbox.github.pull(number).labels).not.toContain('auto:changes-requested');
  }, 60_000);
});

describe('reviews claimed by requested reviewer', () => {
  let sandbox: Sandbox;
  let daemon: ChildProcess;

  beforeAll(() => {
    sandbox = openSandbox({ flows: { review: { schedule: '*/2 * * * * *', agent: 'codex', reviewRequested: '@me' }, fix: { enabled: false } } });
  });

  afterAll(async () => {
    daemon.kill('SIGTERM');
    await closed(daemon);
    await sandbox.github.stop();
  });

  test("leave a pull request to its requested reviewers' machines, and review one this machine is asked to", async () => {
    await sandbox.runCli(['trust', 'demo']);
    sandbox.git(sandbox.checkout, 'checkout', '-qb', 'feature');
    sandbox.git(sandbox.checkout, 'commit', '-q', '--allow-empty', '-m', 'feat: by a person');
    sandbox.git(sandbox.checkout, 'push', '-q', 'origin', 'feature');

    const response = await fetch(`${sandbox.github.url}/repos/dataquail/demo/pulls`, {
      method: 'POST',
      body: JSON.stringify({ head: 'feature', base: 'main', title: 'feat: by a person', body: '' }),
    });

    const { number } = Schema.decodeUnknownSync(CreatedPull)(await response.json());
    sandbox.github.pull(number).labels.push('auto:needs-review');
    sandbox.github.pull(number).reviewers.push('alice');
    daemon = sandbox.cli(['daemon']);

    await waitFor(() => sandbox.daemonLog().includes(`demo/review: skipped: only work for others: pr-${number} (review requested: alice)`), 'a tick that leaves the pull request to alice');
    expect((await sandbox.runCli(['status'])).output).toContain(`assigned elsewhere: pr-${number} (review requested: alice)`);
    expect(sandbox.github.pull(number).labels).toContain('auto:needs-review');

    sandbox.github.pull(number).reviewers.push('Chernabog-Bot');
    await waitFor(() => !sandbox.github.pull(number).labels.includes('auto:needs-review'), 'the review once this machine is asked', 45_000);
  }, 60_000);
});
