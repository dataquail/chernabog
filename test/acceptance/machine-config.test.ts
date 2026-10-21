// Each persona's settings in machine config, keyed by the repo's slug: the
// migration from local.yaml and persona lists, a checkout that goes missing
// or moves, and unenrolling.

import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as Schema from 'effect/Schema';
import YAML from 'yaml';

import { MachineConfigFile } from '../../src/repo-config.ts';
import { closed, openSandbox, type Sandbox, waitFor } from './sandbox.ts';

const reposOf = (sandbox: Sandbox) => Schema.decodeUnknownSync(MachineConfigFile)(YAML.parse(readFileSync(sandbox.machineConfig, 'utf8'))).repos ?? [];

const entryOf = (sandbox: Sandbox) => reposOf(sandbox)[0];

describe('machine config', () => {
  let sandbox: Sandbox;

  beforeAll(() => {
    sandbox = openSandbox({ flows: { fix: { enabled: false } } }, { github: ['alice', 'bob'], flows: {} });
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("rewrites a personas list as a map, and moves local.yaml's choices onto the repo's entry", async () => {
    sandbox.editMachine((document) => {
      document.deleteIn(['repos', 0, 'flows']);
      document.setIn(['repos', 0, 'personas'], document.createNode(['alice', 'bob']));
    });
    writeFileSync(join(sandbox.checkout, '.chernabog', 'local.yaml'), '# mine\nschedule: "5 * * * *"\nflows:\n  review:\n    enabled: false\n  fix:\n    enabled: true\n    concurrency: 1\n');

    const { output } = await sandbox.runCli(['--version']);
    expect(output).toContain("dataquail/demo: personas is now a map of login to that persona's own settings: alice, bob");
    expect(output).toContain('dataquail/demo: listed the flows that ran here: fix, implement');
    expect(output).toContain(`dataquail/demo: moved its schedule and flow choices from ${join(sandbox.checkout, '.chernabog', 'local.yaml')} onto its entry in machine config`);

    const entry = entryOf(sandbox);
    expect(entry.personas).toEqual({ alice: {}, bob: {} });
    expect(entry.flows).toEqual({ fix: { concurrency: 1 }, implement: {} });
    expect(entry.schedule).toBe('5 * * * *');

    // Once is enough: the next command finds nothing to change.
    expect((await sandbox.runCli(['--version'])).output).not.toContain('machine config:');
  }, 30_000);

  test('a missing checkout pauses its repo and keeps its settings; init at its new place points them there', async () => {
    await sandbox.runCli(['trust', 'demo']);
    const moved = join(sandbox.root, 'moved-demo');
    renameSync(sandbox.checkout, moved);

    const daemon = sandbox.cli(['daemon']);
    await waitFor(() => sandbox.daemonLog().includes('listening on'), 'the daemon to start');
    expect((await sandbox.runCli(['status'])).output).toContain(`demo (dataquail/demo): missing — checkout missing at ${sandbox.checkout}`);
    daemon.kill('SIGTERM');
    await closed(daemon);

    // An origin that reads as github.com/dataquail/demo, so init knows the repo.
    sandbox.git(moved, 'remote', 'set-url', 'origin', join(sandbox.root, 'github.com', 'dataquail', 'demo.git'));
    const init = await sandbox.runCli(['init', moved]);
    expect(init.output).toContain(`demo is enrolled at ${sandbox.checkout}, which is gone; chernabog enroll --name demo here points it here, keeping its settings`);

    const enrolled = await sandbox.runCli(['enroll', moved, '--name', 'demo']);
    // As git names it, past any symlink such as macOS's /var.
    const root = realpathSync(moved);
    expect(enrolled.output).toContain(`updated dataquail/demo (${root}`);
    const entry = entryOf(sandbox);
    expect(entry.path).toBe(root);
    expect(entry.flows).toEqual({ fix: { concurrency: 1 }, implement: {} });
  }, 45_000);

  test('unenroll removes a repo and its settings', async () => {
    const { output } = await sandbox.runCli(['unenroll', 'dataquail/demo']);
    expect(output).toContain('removed demo (dataquail/demo');
    expect(reposOf(sandbox)).toEqual([]);
  }, 30_000);
});

describe('setting up and enrolling with flags', () => {
  let sandbox: Sandbox;

  beforeAll(() => {
    sandbox = openSandbox({ flows: { fix: { enabled: false } } }, { github: [], flows: {} });
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("setup chooses gh's logins, and enroll each persona's flows, without asking", async () => {
    sandbox.editMachine((document) => {
      document.deleteIn(['repos']);
    });
    // An origin that reads as github.com/dataquail/demo, so enroll knows the repo.
    sandbox.git(sandbox.checkout, 'remote', 'set-url', 'origin', join(sandbox.root, 'github.com', 'dataquail', 'demo.git'));

    const setUp = await sandbox.runCli(['setup', '--persona', 'alice,bob'], { FAKE_GH_USERS: 'alice,bob' });
    expect(setUp.output).toContain('GitHub personas: alice, bob');

    const enrolled = await sandbox.runCli(['enroll', '--persona', 'bob', '--defaults'], { FAKE_GH_USERS: 'alice,bob' });
    expect(enrolled.output).toContain('demo as bob: flows implement, review');
    expect(entryOf(sandbox).personas).toEqual({ bob: { flows: { implement: {}, review: {} }, account: 'work' } });
  }, 30_000);
});

