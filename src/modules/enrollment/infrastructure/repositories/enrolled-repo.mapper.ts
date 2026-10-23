// An enrolled repo as machine config stores it, and the translation to and
// from the aggregate. Machine config writes the repo entry's own choices
// beside its slug and path, where the root keeps them as its `defaults`; it
// doesn't keep whether the repo is paused, which is runtime state.

import * as Equal from 'effect/Equal';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as Struct from 'effect/Struct';
import type YAML from 'yaml';

import { RepoSlug } from '../../../../kernel/repo-slug.id.ts';
import { EnrolledRepoRoot } from '../../domain/enrolled-repo/enrolled-repo.root.ts';
import { PersonaChoices, PersonaEntry } from '../../domain/enrolled-repo/persona-choices.value-object.ts';

export const EnrolledRepoEntry = Schema.Struct({
  // owner/name on GitHub: the key the entry's settings follow.
  repo: Schema.String,
  // Where its checkout is now.
  path: Schema.String,
  // A short name, which keeps two clones of one repo apart.
  name: Schema.optionalKey(Schema.String),
  // The branch .chernabog/ is trusted from. Defaults to main.
  baseBranch: Schema.optionalKey(Schema.String),
  ...PersonaChoices,
  // The GitHub personas, by login from machine config's github:, that run
  // this repo's flows, each with its own choices. Defaults to the only one;
  // required when there are several.
  personas: Schema.optionalKey(Schema.Record(Schema.String, PersonaEntry)),
});

export type EnrolledRepoEntry = typeof EnrolledRepoEntry.Type;

// The keys of an entry that aren't the repo entry's own choices.
const IDENTITY = ['repo', 'path', 'name', 'baseBranch', 'personas'] as const;

export const toRoot = (entry: EnrolledRepoEntry, paused: boolean) =>
  EnrolledRepoRoot.make({ ...Struct.pick(entry, IDENTITY), repo: RepoSlug.make(entry.repo), defaults: Struct.omit(entry, IDENTITY), paused });

export const toEntry = (root: EnrolledRepoRoot): EnrolledRepoEntry => ({ ...Struct.omit(root, ['defaults', 'paused']), ...root.defaults });

const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));

// Writes `after` onto the document at `path`, where it held `before`: only
// what changed, so the rest, comments included, stays as it was.
const applyChanges = (document: YAML.Document, path: ReadonlyArray<string | number>, before: Option.Option<Schema.Json>, after: Option.Option<Schema.Json>) => {
  if (Option.isNone(after)) {
    if (Option.isSome(before)) document.deleteIn(path);

    return;
  }

  if (Option.isSome(before) && isJsonObject(before.value) && isJsonObject(after.value)) {
    const was = before.value;
    const now = after.value;

    for (const key of Object.keys(was).filter((known) => !(known in now))) document.deleteIn([...path, key]);

    for (const [key, value] of Object.entries(now)) applyChanges(document, [...path, key], Option.fromUndefinedOr(was[key]), Option.some(value));

    return;
  }

  // A scalar or a list is written whole when it changed.
  if (!Option.exists(before, (found) => Equal.equals(found, after.value))) document.setIn(path, document.createNode(after.value));
};

const encodeEntry = (root: EnrolledRepoRoot) => Schema.decodeUnknownSync(Schema.Json)(Schema.encodeSync(EnrolledRepoEntry)(toEntry(root)));

// Whether two roots store the same entry: whatever else differs is runtime state.
export const sameEntry = (left: EnrolledRepoRoot, right: EnrolledRepoRoot) => Equal.equals(encodeEntry(left), encodeEntry(right));

// Writes what changed between two roots onto the entry at `index` in machine
// config's document.
export const applyEntry = (document: YAML.Document, index: number, before: EnrolledRepoRoot, after: EnrolledRepoRoot) => {
  applyChanges(document, ['repos', index], Option.some(encodeEntry(before)), Option.some(encodeEntry(after)));
};
