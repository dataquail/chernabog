import { DEFAULT_LABELS } from '@chernabog/sdk';
import { expect, test } from 'bun:test';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

import { effect } from '../test/effect-test.ts';
import { fixture } from '../test/fixtures.ts';
import { desiredLabels, Label, planLabelSync } from './labels.ts';

const DESIRED = desiredLabels(DEFAULT_LABELS);

// The first desired label exists as it should; the second exists with the wrong color.
const asWanted = DESIRED.slice(0, 1).map((label) => ({ ...label, description: Option.some(label.description) }));
const drifted = DESIRED.slice(1, 2).map((label) => ({ ...label, description: Option.some(label.description), color: 'FFFFFF' }));

test('missing labels are created, drifted ones corrected, others left alone', () => {
  const existing = [{ name: 'bug', color: 'd73a4a', description: Option.some("Something isn't working") }, ...asWanted, ...drifted];
  const changes = planLabelSync(existing, DESIRED);
  const actionFor = (name: string) => Option.map(Arr.findFirst(changes, (change) => change.label.name === name), (change) => change.action);
  expect(drifted.map((label) => actionFor(label.name))).toEqual([Option.some('update')]);
  expect(asWanted.map((label) => actionFor(label.name))).toEqual([Option.none()]);
  expect(changes.filter((change) => change.action === 'create')).toHaveLength(DESIRED.length - 2);
});

effect(
  'a repo with none of them yet gets all of them',
  () => Effect.gen(function* () {
    const recorded = yield* fixture('goodbones-labels.json', Schema.Array(Label));
    const changes = planLabelSync(recorded, DESIRED);
    expect(changes.map((change) => change.label.name)).toEqual(DESIRED.map((label) => label.name));
    expect(changes.every((change) => change.action === 'create')).toBe(true);
  }),
);

test("a repo's own label names are the ones synced", () => {
  expect(desiredLabels({ ...DEFAULT_LABELS, eligible: 'agent:queued' })[0]?.name).toBe('agent:queued');
});
