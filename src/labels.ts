// Creates a repo's labels, and corrects their colour or description where they
// drifted. Labels it does not own are left alone.

import type { Flow, Labels } from '@chernabog/sdk';
import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as Struct from 'effect/Struct';

import { githubGetAllPages, githubSend } from './GitHubApi.ts';

export const Label = Schema.Struct({ name: Schema.String, color: Schema.String, description: Schema.OptionFromNullOr(Schema.String) });

export type Label = typeof Label.Type;

export type DesiredLabel = { readonly name: string; readonly color: string; readonly description: string };

export type LabelChange = { readonly action: 'create' | 'update'; readonly label: DesiredLabel };

const LOOK = {
  eligible: { color: '0e8a16', description: 'Queued for an unattended run; removed on claim' },
  inProgress: { color: 'fbca04', description: 'An unattended run owns this issue' },
  needsReview: { color: '1d76db', description: 'PR is open and green; waiting for a person to review it' },
  changesRequested: { color: 'e99695', description: 'Review comments posted; waiting for a push' },
  approved: { color: '0e8a16', description: 'Approved by an agent review; a person merges' },
  needsHuman: { color: 'b60205', description: 'A loop cap or a rule stopped the run; a person takes over' },
  needsClarification: { color: 'd876e3', description: 'Questions are on the issue; answer, then requeue' },
  stale: { color: '7f8c8d', description: 'No push before the staleness timeout' },
  ship: { color: '5319e7', description: 'The automated path: chernabog implements, and merges once a review approves' },
  hybrid: { color: 'bfd4f2', description: 'The hybrid path: a person worked on it with an agent; a person merges' },
} satisfies Readonly<Record<keyof Labels, { readonly color: string; readonly description: string }>>;

export const desiredLabels = (labels: Labels): ReadonlyArray<DesiredLabel> => Struct.keys(LOOK).map((key) => ({ name: labels[key], ...LOOK[key] }));

const FLOW_LABEL_COLOR = 'c5def5';

// The labels the repo's flows declare, after the repo's own: a name already
// there keeps the look it has.
export const withFlowLabels = (desired: ReadonlyArray<DesiredLabel>, flows: Iterable<Flow>): ReadonlyArray<DesiredLabel> => {
  const all = [...desired];

  for (const flow of flows) {
    for (const label of flow.labels ?? []) {
      if (!all.some((known) => known.name.toLowerCase() === label.name.toLowerCase())) {
        all.push({ name: label.name, color: label.color ?? FLOW_LABEL_COLOR, description: label.description ?? 'Declared by a Chernabog flow' });
      }
    }
  }

  return all;
};

const drifted = (current: Label, label: DesiredLabel) => current.color.toLowerCase() !== label.color || Option.getOrElse(current.description, () => '') !== label.description;

export const planLabelSync = (existing: ReadonlyArray<Label>, desired: ReadonlyArray<DesiredLabel>): ReadonlyArray<LabelChange> =>
  desired.flatMap((label): ReadonlyArray<LabelChange> =>
    Option.match(
      Arr.findFirst(existing, (candidate) => candidate.name.toLowerCase() === label.name.toLowerCase()),
      {
        onNone: () => [{ action: 'create', label }],
        onSome: (current): ReadonlyArray<LabelChange> => {
          if (drifted(current, label)) return [{ action: 'update', label }];

          return [];
        },
      },
    ),
  );

const PAST_TENSE = { create: 'created', update: 'updated' } as const;

const verb = (change: LabelChange) => PAST_TENSE[change.action];

export const syncLabels = (repo: string, desired: ReadonlyArray<DesiredLabel>) =>
  Effect.gen(function* () {
    const existing = yield* githubGetAllPages(`/repos/${repo}/labels?per_page=100`, Schema.Array(Label), (page) => page);
    const changes = planLabelSync(existing, desired);

    for (const { action, label } of changes) {
      if (action === 'create') yield* githubSend('POST', `/repos/${repo}/labels`, Option.some(label));
      else yield* githubSend('PATCH', `/repos/${repo}/labels/${encodeURIComponent(label.name)}`, Option.some({ color: label.color, description: label.description }));
    }

    if (changes.length === 0) return `${repo}: labels up to date`;

    return `${repo}: ${changes.map((change) => `${verb(change)} ${change.label.name}`).join(', ')}`;
  });
