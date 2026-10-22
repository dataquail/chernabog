// Recipes through the CLI: init bakes only the ones chosen, none without a
// choice, and a set-up repo adds more later and diffs its flows against them.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { RECIPE_FILES } from '../../src/templates.ts';
import { openSandbox, type Sandbox } from './sandbox.ts';

describe('recipes', () => {
  let sandbox: Sandbox;
  const flow = (name: string) => join(sandbox.checkout, '.chernabog', 'flows', `${name}.ts`);

  beforeAll(() => {
    sandbox = openSandbox({}, { recipes: [] });
    // An origin that reads as github.com/dataquail/demo, so init knows the repo.
    sandbox.git(sandbox.checkout, 'remote', 'set-url', 'origin', join(sandbox.root, 'github.com', 'dataquail', 'demo.git'));
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test('init without a choice bakes none, and enrolls nothing until the repo has a flow', async () => {
    const { output } = await sandbox.runCli(['init']);
    expect(output).not.toContain('wrote .chernabog/');
    expect(output).toContain('Not enrolled: .chernabog/flows/ has no flows. Add recipes with chernabog recipes add');
    expect(existsSync(join(sandbox.checkout, '.chernabog', 'flows'))).toBe(false);
  }, 30_000);

  test('recipes list names each, with its description and docs page', async () => {
    const { output } = await sandbox.runCli(['recipes', 'list']);
    expect(output).toContain('  human-initiated: The hybrid path');
    expect(output).toContain('    https://dataquail.github.io/chernabog/recipes/human-initiated/');
  }, 30_000);

  test('init --recipes bakes the ones named, as the full flow, and enrolls the repo with them', async () => {
    const { output } = await sandbox.runCli(['init', '--recipes', 'implement,review', '--defaults']);
    expect(output).toContain('wrote .chernabog/flows/implement.ts (implement recipe)');
    expect(output).toContain('wrote .chernabog/prompts/review.md (review recipe)');
    expect(output).toContain('demo as this machine: flows implement, review');
    expect(readFileSync(flow('review'), 'utf8')).toBe(RECIPE_FILES['flows/review.ts']);
    expect(existsSync(flow('re-review'))).toBe(false);
  }, 30_000);

  test('recipes add bakes more later, and never overwrites a flow the repo has', async () => {
    const added = await sandbox.runCli(['recipes', 'add', 'human-initiated', 'review']);
    expect(added.output).toContain('wrote .chernabog/flows/human-initiated.ts (human-initiated recipe)');
    expect(added.output).toContain('kept .chernabog/flows/review.ts, which is already there');

    const listed = await sandbox.runCli(['recipes', 'list']);
    expect(listed.output).toContain('✓ human-initiated');
    expect(listed.output).toContain('  re-review');

    const refused = await sandbox.runCli(['recipes', 'add', 'ship']);
    expect(refused.output).toContain('no recipe named ship');
  }, 30_000);

  test("recipes diff shows how the repo's flows differ from the current recipes", async () => {
    writeFileSync(flow('implement'), RECIPE_FILES['flows/implement.ts'].replace('concurrency: 1,', 'concurrency: 3,'));
    const { code, output } = await sandbox.runCli(['recipes', 'diff']);
    expect(code).toBe(0);
    expect(output).toContain('Against the recipes of chernabog ');
    expect(output).toContain('.chernabog/flows/implement.ts: differs from the implement recipe (https://dataquail.github.io/chernabog/recipes/implement/)');
    expect(output).toContain('-  concurrency: 1,\n+  concurrency: 3,');
    expect(output).toContain('.chernabog/flows/review.ts: the same as the review recipe');
    expect(output).toContain('.chernabog/flows/human-initiated.ts: the same as the human-initiated recipe');
  }, 30_000);
});
