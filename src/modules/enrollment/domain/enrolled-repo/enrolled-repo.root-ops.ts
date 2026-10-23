// The rules an enrolled repo keeps. Each takes the entry as it is and returns
// the entry as it should be; storing it, and keeping the file's comments, is
// the repository's job.

import * as Arr from 'effect/Array';
import * as Option from 'effect/Option';
import * as Record from 'effect/Record';
import * as Result from 'effect/Result';

import { type Persona } from '../../../../kernel/persona.value-object.ts';
import { AmbiguousClone } from './enrolled-repo.errors.ts';
import { EnrolledRepoRoot } from './enrolled-repo.root.ts';
import { type PersonaFlowSettings } from './flow-settings.value-object.ts';
import { type PersonaEntry } from './persona-choices.value-object.ts';

// The repo's short name: its own, else the name half of its slug.
const nameOf = (repo: EnrolledRepoRoot) => repo.name ?? repo.repo.split('/').at(-1) ?? repo.repo;

const personaEntry = (repo: EnrolledRepoRoot, login: string) => Option.getOrElse(Record.get(repo.personas ?? {}, login), (): PersonaEntry => ({}));

// The choices kept for `owner`: a persona's own entry, or the repo entry's
// defaults for none.
const choicesAt = (repo: EnrolledRepoRoot, owner: Persona) => Option.match(owner, { onNone: () => repo.defaults, onSome: (login) => personaEntry(repo, login) });

const withChoicesAt = (repo: EnrolledRepoRoot, owner: Persona, choices: PersonaEntry) =>
  Option.match(owner, {
    onNone: () => EnrolledRepoRoot.make({ ...repo, defaults: choices }),
    onSome: (login) => EnrolledRepoRoot.make({ ...repo, personas: { ...repo.personas, [login]: choices } }),
  });

// A persona's choices for a repo: its own entry's keys over the repo entry's.
const choicesOf = (repo: EnrolledRepoRoot, persona: Persona): PersonaEntry => ({ ...repo.defaults, ...Option.getOrElse(Option.flatMap(persona, (login) => Record.get(repo.personas ?? {}, login)), () => ({})) });

// What an enrolment says about the checkout it's run in.
export type Enrolling = { readonly repo: string; readonly name: Option.Option<string>; readonly path: string };

// The entry an enrolment updates, by its index: the one with its slug, and its
// name when one is given. Of several clones with no name given, the one at
// the enrolment's path. None when the repo isn't enrolled yet.
const entryFor = (repos: ReadonlyArray<EnrolledRepoRoot>, enrolling: Enrolling): Result.Result<Option.Option<number>, AmbiguousClone> => {
  const clones = Arr.filter(Arr.map(repos, (entry, index) => ({ entry, index })), ({ entry }) => entry.repo === enrolling.repo);
  const found = (clone: Option.Option<{ readonly index: number }>) => Result.succeed(Option.map(clone, ({ index }) => index));

  for (const named of Option.toArray(enrolling.name)) return found(Arr.findFirst(clones, ({ entry }) => nameOf(entry) === named));

  if (clones.length < 2) return found(Arr.head(clones));

  const here = Arr.findFirst(clones, ({ entry }) => entry.path === enrolling.path);

  if (Option.isSome(here)) return found(here);

  return Result.fail(new AmbiguousClone({ repo: clones[0].entry.repo, names: clones.map(({ entry }) => nameOf(entry)) }));
};

// An entry enrolled again: each key the enrolment gives replaces the entry's,
// and every other setting, such as its personas and flows, survives, so a
// checkout that moved keeps its settings at its new path.
const reenroll = (existing: EnrolledRepoRoot, given: EnrolledRepoRoot) => EnrolledRepoRoot.make({ ...existing, ...given, defaults: { ...existing.defaults, ...given.defaults } });

// Whose flows a persona's flow change edits: its own entry's when it has
// them, else the repo entry's, which every persona inherits. A persona that
// inherits them, and is one of several, gets its own copy first, so a change
// for it leaves the others theirs. `owner` is none for the repo entry.
const ownFlows = (repo: EnrolledRepoRoot, persona: Persona): { readonly repo: EnrolledRepoRoot; readonly owner: Persona } =>
  Option.match(persona, {
    onNone: () => ({ repo, owner: persona }),
    onSome: (login) => {
      if (Option.isSome(Option.fromUndefinedOr(personaEntry(repo, login).flows))) return { repo, owner: persona };

      if (Object.keys(repo.personas ?? {}).length < 2) return { repo, owner: Option.none() };

      return { repo: withChoicesAt(repo, persona, { ...personaEntry(repo, login), flows: repo.defaults.flows ?? {} }), owner: persona };
    },
  });

// Changes one flow in the flows a persona's change edits, copying inherited
// ones first. `change` gets the flow's settings, none when it isn't listed,
// and returns them, none to leave it out.
const editFlow = (repo: EnrolledRepoRoot, persona: Persona, flow: string, change: (settings: Option.Option<PersonaFlowSettings>) => Option.Option<PersonaFlowSettings>) => {
  const owned = ownFlows(repo, persona);
  const choices = choicesAt(owned.repo, owned.owner);
  const flows = choices.flows ?? {};
  const { [flow]: _flow, ...others } = flows;
  const changed = Option.match(change(Record.get(flows, flow)), { onNone: () => others, onSome: (settings) => ({ ...flows, [flow]: settings }) });

  return withChoicesAt(owned.repo, owned.owner, { ...choices, flows: changed });
};

// Turns one flow on or off for a persona. Turning a flow off keeps its
// settings, as enabled: false, when it has any.
const setFlow = (repo: EnrolledRepoRoot, persona: Persona, flow: string, enabled: boolean) =>
  editFlow(repo, persona, flow, (settings) => {
    const { enabled: _enabled, ...rest } = Option.getOrElse(settings, (): PersonaFlowSettings => ({}));

    if (enabled) return Option.some(rest);

    return Option.map(Option.liftPredicate(rest, (kept) => Object.keys(kept).length > 0), (kept) => ({ ...kept, enabled: false }));
  });

// Overrides a flow's schedule for a persona, or clears the override so the
// team's applies again. A flow the persona doesn't run keeps the override, off.
const setFlowSchedule = (repo: EnrolledRepoRoot, persona: Persona, flow: string, schedule: Option.Option<string>) =>
  editFlow(repo, persona, flow, (settings) =>
    Option.match(schedule, {
      onNone: () => Option.map(settings, ({ schedule: _schedule, ...rest }) => rest),
      onSome: (cron) => Option.some({ ...Option.getOrElse(settings, (): PersonaFlowSettings => ({ enabled: false })), schedule: cron }),
    }),
  );

const withoutAccount = ({ account: _account, ...rest }: PersonaEntry): PersonaEntry => rest;

const withoutRoles = ({ roles: _roles, ...rest }: PersonaEntry): PersonaEntry => rest;

// An emptied roles map goes with the last role.
const withoutEmptyRoles = (choices: PersonaEntry) => {
  if (Option.fromUndefinedOr(choices.roles).pipe(Option.exists((roles) => Object.keys(roles).length === 0))) return withoutRoles(choices);

  return choices;
};

const withoutRole = (choices: PersonaEntry, role: string) => {
  const { [role]: _role, ...roles } = choices.roles ?? {};

  return withoutEmptyRoles({ ...choices, roles });
};

const pickAccount = (choices: PersonaEntry, role: Option.Option<string>, account: Option.Option<string>): PersonaEntry =>
  Option.match(role, {
    onNone: () => Option.match(account, { onNone: () => withoutEmptyRoles(withoutAccount(choices)), onSome: (chosen) => ({ ...choices, account: chosen }) }),
    onSome: (named) => Option.match(account, { onNone: () => withoutRole(choices, named), onSome: (chosen) => ({ ...choices, roles: { ...choices.roles, [named]: chosen } }) }),
  });

// Picks the account a persona spends, or one of its roles does, or clears the
// pick so the default applies again. It's kept on the persona's own entry when
// it has one, else on the repo entry, which it runs from.
const setAccount = (repo: EnrolledRepoRoot, persona: Persona, role: Option.Option<string>, account: Option.Option<string>) => {
  const owner = Option.filter(persona, (login) => Record.has(repo.personas ?? {}, login));

  return withChoicesAt(repo, owner, pickAccount(choicesAt(repo, owner), role, account));
};

export const EnrolledRepoRootOps = { nameOf, choicesOf, entryFor, reenroll, ownFlows, setFlow, setFlowSchedule, setAccount } as const;
