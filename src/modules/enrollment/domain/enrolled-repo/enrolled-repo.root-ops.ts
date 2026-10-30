// The rules an enrolled repo keeps. Each takes the entry as it is and returns
// the entry as it should be; storing it, and keeping the file's comments, is
// the repository's job.

import * as Arr from "effect/Array";
import * as Cron from "effect/Cron";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";

import { asSuffix, IMPLICIT, type Persona } from "../../../../kernel/persona.value-object.ts";
import { type RepoSlug } from "../../../../kernel/repo-slug.id.ts";
import { type Checkout } from "./checkout.value-object.ts";
import {
  AccountsClash,
  AmbiguousClone,
  FlowUnavailable,
  InvalidSchedule,
  NoAccountForAgent,
  NoFlows,
  NoPersonaChosen,
  NoPersonasToChoose,
  PersonaChoiceNeeded,
  RepoNotEnrolled,
  UnknownAccount,
  UnknownFlow,
  UnknownPersona,
} from "./enrolled-repo.errors.ts";
import { EnrolledRepoRoot } from "./enrolled-repo.root.ts";
import { type PersonaFlowSettings } from "./flow-settings.value-object.ts";
import { type MachineOffer } from "./machine-offer.value-object.ts";
import { type PersonaEntry } from "./persona-choices.value-object.ts";
import { FLOW_TURNED_OFF, type TeamFlows } from "./team-flows.value-object.ts";

// The repo's short name: its own, else the name half of its slug.
const nameOf = (repo: EnrolledRepoRoot) => repo.name ?? repo.repo.split("/").at(-1) ?? repo.repo;

const personaEntry = (repo: EnrolledRepoRoot, login: string) =>
  Option.getOrElse(Record.get(repo.personas ?? {}, login), (): PersonaEntry => ({}));

// The choices kept for `owner`: a persona's own entry, or the repo entry's
// defaults for none.
const choicesAt = (repo: EnrolledRepoRoot, owner: Persona) =>
  Option.match(owner, {
    onNone: () => repo.defaults,
    onSome: (login) => personaEntry(repo, login),
  });

const withChoicesAt = (repo: EnrolledRepoRoot, owner: Persona, choices: PersonaEntry) =>
  Option.match(owner, {
    onNone: () => EnrolledRepoRoot.make({ ...repo, defaults: choices }),
    onSome: (login) =>
      EnrolledRepoRoot.make({ ...repo, personas: { ...repo.personas, [login]: choices } }),
  });

// A persona's choices for a repo: its own entry's keys over the repo entry's.
const choicesOf = (repo: EnrolledRepoRoot, persona: Persona): PersonaEntry => ({
  ...repo.defaults,
  ...Option.getOrElse(
    Option.flatMap(persona, (login) => Record.get(repo.personas ?? {}, login)),
    () => ({}),
  ),
});

// What an enrolment says about the checkout it's run in.
export type Enrolling = {
  readonly repo: string;
  readonly name: Option.Option<string>;
  readonly path: string;
};

// The entry an enrolment updates, by its index: the one with its slug, and its
// name when one is given. Of several clones with no name given, the one at
// the enrolment's path. None when the repo isn't enrolled yet.
const entryFor = (
  repos: ReadonlyArray<EnrolledRepoRoot>,
  enrolling: Enrolling,
): Result.Result<Option.Option<number>, AmbiguousClone> => {
  const clones = Arr.filter(
    Arr.map(repos, (entry, index) => ({ entry, index })),
    ({ entry }) => entry.repo === enrolling.repo,
  );

  const found = (clone: Option.Option<{ readonly index: number }>) =>
    Result.succeed(Option.map(clone, ({ index }) => index));

  for (const named of Option.toArray(enrolling.name)) {
    return found(Arr.findFirst(clones, ({ entry }) => nameOf(entry) === named));
  }

  if (clones.length < 2) {
    return found(Arr.head(clones));
  }

  const here = Arr.findFirst(clones, ({ entry }) => entry.path === enrolling.path);

  if (Option.isSome(here)) {
    return found(here);
  }

  return Result.fail(
    new AmbiguousClone({
      repo: clones[0].entry.repo,
      names: clones.map(({ entry }) => nameOf(entry)),
    }),
  );
};

// An entry enrolled again: each key the enrolment gives replaces the entry's,
// and every other setting, such as its personas and flows, survives, so a
// checkout that moved keeps its settings at its new path.
const reenroll = (existing: EnrolledRepoRoot, given: EnrolledRepoRoot) =>
  EnrolledRepoRoot.make({
    ...existing,
    ...given,
    defaults: { ...existing.defaults, ...given.defaults },
  });

// Whose flows a persona's flow change edits: its own entry's when it has
// them, else the repo entry's, which every persona inherits. A persona that
// inherits them, and is one of several, gets its own copy first, so a change
// for it leaves the others theirs. `owner` is none for the repo entry.
const ownFlows = (
  repo: EnrolledRepoRoot,
  persona: Persona,
): { readonly repo: EnrolledRepoRoot; readonly owner: Persona } =>
  Option.match(persona, {
    onNone: () => ({ repo, owner: persona }),
    onSome: (login) => {
      if (Option.isSome(Option.fromUndefinedOr(personaEntry(repo, login).flows))) {
        return { repo, owner: persona };
      }

      if (Object.keys(repo.personas ?? {}).length < 2) {
        return { repo, owner: Option.none() };
      }

      return {
        repo: withChoicesAt(repo, persona, {
          ...personaEntry(repo, login),
          flows: repo.defaults.flows ?? {},
        }),
        owner: persona,
      };
    },
  });

// Changes one flow in the flows a persona's change edits, copying inherited
// ones first. `change` gets the flow's settings, none when it isn't listed,
// and returns them, none to leave it out.
const editFlow = (
  repo: EnrolledRepoRoot,
  persona: Persona,
  flow: string,
  change: (settings: Option.Option<PersonaFlowSettings>) => Option.Option<PersonaFlowSettings>,
) => {
  const owned = ownFlows(repo, persona);
  const choices = choicesAt(owned.repo, owned.owner);
  const flows = choices.flows ?? {};
  const { [flow]: _flow, ...others } = flows;

  const changed = Option.match(change(Record.get(flows, flow)), {
    onNone: () => others,
    onSome: (settings) => ({ ...flows, [flow]: settings }),
  });

  return withChoicesAt(owned.repo, owned.owner, { ...choices, flows: changed });
};

// Turns one flow on or off for a persona. Turning a flow off keeps its
// settings, as enabled: false, when it has any.
const setFlow = (repo: EnrolledRepoRoot, persona: Persona, flow: string, enabled: boolean) =>
  editFlow(repo, persona, flow, (settings) => {
    const { enabled: _enabled, ...rest } = Option.getOrElse(
      settings,
      (): PersonaFlowSettings => ({}),
    );

    if (enabled) {
      return Option.some(rest);
    }

    return Option.map(
      Option.liftPredicate(rest, (kept) => Object.keys(kept).length > 0),
      (kept) => ({ ...kept, enabled: false }),
    );
  });

// Overrides a flow's schedule for a persona, or clears the override so the
// team's applies again. A flow the persona doesn't run keeps the override, off.
const setFlowSchedule = (
  repo: EnrolledRepoRoot,
  persona: Persona,
  flow: string,
  schedule: Option.Option<string>,
) =>
  editFlow(repo, persona, flow, (settings) =>
    Option.match(schedule, {
      onNone: () => Option.map(settings, ({ schedule: _schedule, ...rest }) => rest),
      onSome: (cron) =>
        Option.some({
          ...Option.getOrElse(settings, (): PersonaFlowSettings => ({ enabled: false })),
          schedule: cron,
        }),
    }),
  );

const withoutAccount = ({ account: _account, ...rest }: PersonaEntry): PersonaEntry => rest;

const withoutRoles = ({ roles: _roles, ...rest }: PersonaEntry): PersonaEntry => rest;

// An emptied roles map goes with the last role.
const withoutEmptyRoles = (choices: PersonaEntry) => {
  if (
    Option.fromUndefinedOr(choices.roles).pipe(
      Option.exists((roles) => Object.keys(roles).length === 0),
    )
  ) {
    return withoutRoles(choices);
  }

  return choices;
};

const withoutRole = (choices: PersonaEntry, role: string) => {
  const { [role]: _role, ...roles } = choices.roles ?? {};

  return withoutEmptyRoles({ ...choices, roles });
};

const pickAccount = (
  choices: PersonaEntry,
  role: Option.Option<string>,
  account: Option.Option<string>,
): PersonaEntry =>
  Option.match(role, {
    onNone: () =>
      Option.match(account, {
        onNone: () => withoutEmptyRoles(withoutAccount(choices)),
        onSome: (chosen) => ({ ...choices, account: chosen }),
      }),
    onSome: (named) =>
      Option.match(account, {
        onNone: () => withoutRole(choices, named),
        onSome: (chosen) => ({ ...choices, roles: { ...choices.roles, [named]: chosen } }),
      }),
  });

// Picks the account a persona spends, or one of its roles does, or clears the
// pick so the default applies again. It's kept on the persona's own entry when
// it has one, else on the repo entry, which it runs from.
const setAccount = (
  repo: EnrolledRepoRoot,
  persona: Persona,
  role: Option.Option<string>,
  account: Option.Option<string>,
) => {
  const owner = Option.filter(persona, (login) => Record.has(repo.personas ?? {}, login));

  return withChoicesAt(repo, owner, pickAccount(choicesAt(repo, owner), role, account));
};

// Whether a person naming a repo means this one: by its name, its slug or its
// checkout's path.
const answersTo = (repo: EnrolledRepoRoot, named: string) =>
  nameOf(repo) === named || repo.repo === named || repo.path === named;

// The repo a person names, of those enrolled.
const named = (repos: ReadonlyArray<EnrolledRepoRoot>, name: string) =>
  Result.fromOption(
    Arr.findFirst(repos, (repo) => answersTo(repo, name)),
    () => new RepoNotEnrolled({ asked: name, enrolled: repos.map(nameOf) }),
  );

// A paused repo starts no new runs; pausing one that is changes nothing.
const pause = (repo: EnrolledRepoRoot) => EnrolledRepoRoot.make({ ...repo, paused: true });

const resume = (repo: EnrolledRepoRoot) => EnrolledRepoRoot.make({ ...repo, paused: false });

// Whether a login is one of a flow's runners. Logins are case-insensitive, as on GitHub.
const isRunner = (runners: ReadonlyArray<string>, login: string) =>
  runners.some((runner) => runner.toLowerCase() === login.toLowerCase());

// Why the team doesn't have these logins run a flow with these runners, if it doesn't.
const notARunner = (runners: ReadonlyArray<string>, logins: ReadonlyArray<string>) => {
  const who = Option.match(Option.liftPredicate(logins, Arr.isReadonlyArrayNonEmpty), {
    onNone: () => "this machine's GitHub login is unknown",
    onSome: (found) => `this machine is ${found.join(", ")}`,
  });

  return Option.liftPredicate(
    `not a runner (runners: ${runners.join(", ")}; ${who})`,
    () => !logins.some((login) => isRunner(runners, login)),
  );
};

// Why the team has a flow off for these logins, if it does: its
// flows.<flow>.enabled, else its runners. What enrolling offers by default.
const teamOff = (team: TeamFlows, flow: string, logins: ReadonlyArray<string>) =>
  Option.orElse(
    Option.liftPredicate(FLOW_TURNED_OFF, () => team.flows[flow]?.enabled === false),
    () =>
      Option.flatMap(
        Option.orElse(Option.fromUndefinedOr(team.flows[flow]?.runners), () => team.runners),
        (runners) => notARunner(runners, logins),
      ),
  );

// The agents a flow runs: its own, its roles', and the repo's.
const agentsOf = (team: TeamFlows, flow: string) =>
  Arr.dedupe([
    ...Option.toArray(Option.fromUndefinedOr(team.flows[flow]?.agent)),
    ...Object.values(team.flows[flow]?.agents ?? {}),
    ...Option.toArray(team.agent),
  ]);

// Why a flow can't run on this machine: an agent it needs has no account.
const unavailable = (machine: MachineOffer, team: TeamFlows, flow: string) => {
  const missing = agentsOf(team, flow).filter(
    (agent) => !machine.accounts.some((account) => account.agent === agent),
  );

  return Option.map(
    Option.liftPredicate(missing, Arr.isReadonlyArrayNonEmpty),
    (agents) => `needs ${agents.join(" and ")}; add an account for each with chernabog setup`,
  );
};

// A flow as enrolling offers it to a persona: on by the team's default, and
// whether this machine has an account for every agent it needs.
export type FlowOffer = {
  readonly name: string;
  readonly teamDefault: boolean;
  readonly teamOff: Option.Option<string>;
  readonly unavailable: Option.Option<string>;
};

// The checkout's flows as offered to a persona, who is `logins` on GitHub.
const flowOffers = (checkout: Checkout, machine: MachineOffer, logins: ReadonlyArray<string>) =>
  checkout.flows.map((name): FlowOffer => {
    const off = teamOff(checkout.team, name, logins);

    return {
      name,
      teamDefault: Option.isNone(off),
      teamOff: off,
      unavailable: unavailable(machine, checkout.team, name),
    };
  });

// The flows a persona runs when nothing says otherwise: the team's, that it can.
const defaultFlows = (offers: ReadonlyArray<FlowOffer>) =>
  offers.flatMap((offer) =>
    Option.toArray(
      Option.liftPredicate(offer.name, () => offer.teamDefault && Option.isNone(offer.unavailable)),
    ),
  );

// The flows a persona runs now, by the repo's entry: the ones listed and not off.
const currentFlows = (repo: Option.Option<EnrolledRepoRoot>, persona: Persona) =>
  Option.flatMap(repo, (found) =>
    Option.map(Option.fromUndefinedOr(choicesOf(found, persona).flows), (flows) =>
      Object.entries(flows).flatMap(([flow, settings]) =>
        Option.toArray(Option.liftPredicate(flow, () => settings.enabled !== false)),
      ),
    ),
  );

// The personas a repo enrolled before has entries of its own for.
const currentPersonas = (repo: Option.Option<EnrolledRepoRoot>) =>
  Option.flatMap(repo, (found) =>
    Option.map(Option.fromUndefinedOr(found.personas), (personas) => Object.keys(personas)),
  );

// Which personas work in a repo: the ones named, else the machine's only one,
// else the ones it has now. A machine without personas has the implicit one.
const choosePersonas = (
  machine: MachineOffer,
  current: Option.Option<ReadonlyArray<string>>,
  asked: Option.Option<ReadonlyArray<string>>,
): Result.Result<
  Arr.NonEmptyReadonlyArray<Persona>,
  NoPersonasToChoose | UnknownPersona | PersonaChoiceNeeded | NoPersonaChosen
> => {
  const logins = machine.personas;

  if (logins.length === 0) {
    return Option.match(asked, {
      onSome: () => Result.fail(new NoPersonasToChoose()),
      onNone: () => Result.succeed(Arr.of(IMPLICIT)),
    });
  }

  const chosen = Option.match(asked, {
    onSome: (names): Result.Result<ReadonlyArray<string>, UnknownPersona | PersonaChoiceNeeded> => {
      const unknown = names.filter((login) => !logins.includes(login));

      if (unknown.length > 0) {
        return Result.fail(new UnknownPersona({ logins: unknown, known: logins }));
      }

      return Result.succeed(Arr.dedupe(names));
    },
    onNone: (): Result.Result<ReadonlyArray<string>, UnknownPersona | PersonaChoiceNeeded> => {
      if (logins.length === 1) {
        return Result.succeed(logins);
      }

      return Result.fromOption(current, () => new PersonaChoiceNeeded({ logins }));
    },
  });

  return Result.flatMap(chosen, (found) =>
    Result.fromOption(
      Option.map(Option.liftPredicate(found, Arr.isReadonlyArrayNonEmpty), (chosenLogins) =>
        Arr.map(chosenLogins, (login): Persona => Option.some(login)),
      ),
      () => new NoPersonaChosen(),
    ),
  );
};

// The flows one persona runs: the ones a person chose, which must be the
// checkout's and runnable here, else the ones it runs now, else the defaults.
const chooseFlows = (
  offers: ReadonlyArray<FlowOffer>,
  current: Option.Option<ReadonlyArray<string>>,
  chosen: Option.Option<ReadonlyArray<string>>,
): Result.Result<ReadonlyArray<string>, UnknownFlow | FlowUnavailable> =>
  Option.match(chosen, {
    onNone: () => Result.succeed(Option.getOrElse(current, () => defaultFlows(offers))),
    onSome: (names) => {
      for (const name of names) {
        const offer = Arr.findFirst(offers, (candidate) => candidate.name === name);

        if (Option.isNone(offer)) {
          return Result.fail(
            new UnknownFlow({ flow: name, known: offers.map((known) => known.name) }),
          );
        }

        for (const reason of Option.toArray(offer.value.unavailable)) {
          return Result.fail(new FlowUnavailable({ flow: name, reason }));
        }
      }

      return Result.succeed(Arr.dedupe(names));
    },
  });

type OfferedAccount = MachineOffer["accounts"][number];

// One account of `candidates`: the one named, else the only one, else the one
// chosen before, else the first.
const oneAccount = (
  candidates: Arr.NonEmptyReadonlyArray<OfferedAccount>,
  picked: ReadonlyArray<string>,
  current: ReadonlyArray<string>,
) =>
  Option.getOrElse(
    Option.orElse(
      Arr.findFirst(candidates, (account) => picked.includes(account.name)),
      () => Arr.findFirst(candidates, (account) => current.includes(account.name)),
    ),
    () => candidates[0],
  );

// The accounts a persona may spend as its own: the repo's agent's, or any.
const mainAccounts = (machine: MachineOffer, team: TeamFlows) =>
  Option.match(team.agent, {
    onNone: () => machine.accounts,
    onSome: (agent) => machine.accounts.filter((account) => account.agent === agent),
  });

// The agents a persona's flows need besides its own account's, each of which
// gets an account of its own where the machine has several.
const otherAgents = (team: TeamFlows, flows: ReadonlyArray<string>, own: string) =>
  Arr.dedupe(flows.flatMap((flow) => agentsOf(team, flow))).filter((agent) => agent !== own);

// What a persona owns of its account choices now.
export type OwnAccounts = {
  readonly account: Option.Option<string>;
  readonly accounts: ReadonlyArray<string>;
};

// The accounts one persona spends: its own, for the repo's agent, and one for
// each other agent its flows need where there's a choice. `picked` are the
// ones a person chose; the rest are the ones chosen before, else the first.
const chooseAccounts = (
  machine: MachineOffer,
  team: TeamFlows,
  flows: ReadonlyArray<string>,
  own: OwnAccounts,
  picked: ReadonlyArray<string>,
): Result.Result<OwnAccounts, NoAccountForAgent | UnknownAccount> => {
  const base = mainAccounts(machine, team);

  if (!Arr.isReadonlyArrayNonEmpty(base)) {
    return Result.fail(new NoAccountForAgent({ agent: team.agent }));
  }

  const main = oneAccount(base, picked, Option.toArray(own.account));

  const others = otherAgents(team, flows, main.agent).flatMap((agent) => {
    const candidates = machine.accounts.filter((account) => account.agent === agent);

    if (!Arr.isReadonlyArrayNonEmpty(candidates) || candidates.length < 2) {
      return [];
    }

    return [oneAccount(candidates, picked, own.accounts).name];
  });

  const unknown = picked.filter(
    (name) => !machine.accounts.some((account) => account.name === name),
  );

  if (unknown.length > 0) {
    return Result.fail(
      new UnknownAccount({
        names: unknown,
        known: machine.accounts.map((account) => account.name),
      }),
    );
  }

  return Result.succeed({
    account: Option.liftPredicate(main.name, () => machine.accounts.length > 1),
    accounts: others,
  });
};

// What enrolling chose for one persona of a repo.
export type PersonaEnrolment = {
  readonly persona: Persona;
  readonly flows: ReadonlyArray<string>;
  // Its account, when the machine has a choice of them.
  readonly account: Option.Option<string>;
  // Its accounts for other agents, where an agent has several.
  readonly accounts: ReadonlyArray<string>;
};

// A persona's choices with these flows, keeping the settings of the ones it
// lists already, and these accounts.
const withEnrolment = (choices: PersonaEntry, one: PersonaEnrolment): PersonaEntry => {
  const listed = choices.flows ?? {};

  const flows = Object.fromEntries(
    one.flows.map((flow) => [
      flow,
      Option.match(Record.get(listed, flow), {
        onNone: (): PersonaFlowSettings => ({}),
        onSome: ({ enabled: _enabled, ...settings }) => settings,
      }),
    ]),
  );

  const { accounts: _accounts, ...rest } = choices;

  return {
    ...rest,
    flows,
    ...Option.match(one.account, { onNone: () => ({}), onSome: (account) => ({ account }) }),
    ...Option.match(Option.liftPredicate(one.accounts, Arr.isReadonlyArrayNonEmpty), {
      onNone: () => ({}),
      onSome: (accounts) => ({ accounts }),
    }),
  };
};

// Writes what enrolling chose: on the repo's entry, which every persona
// inherits, or, with `perPersona`, on each persona's own entry, dropping
// personas no longer chosen.
const enrolPersonas = (
  repo: EnrolledRepoRoot,
  chosen: ReadonlyArray<PersonaEnrolment>,
  perPersona: boolean,
) => {
  const logins = chosen.flatMap((one) => Option.toArray(one.persona));

  let enrolled = Option.match(
    Option.liftPredicate(repo.personas ?? {}, () => perPersona),
    {
      onNone: () => repo,
      onSome: (personas) =>
        EnrolledRepoRoot.make({
          ...repo,
          personas: Record.filter(personas, (_choices, login) => logins.includes(login)),
        }),
    },
  );

  for (const one of chosen) {
    const owner = Option.filter(one.persona, () => perPersona);
    enrolled = withChoicesAt(enrolled, owner, withEnrolment(choicesAt(enrolled, owner), one));
  }

  return enrolled;
};

// The repo a checkout is of, enrolled: its entry updated when it has one,
// keeping every setting, else a new one. `name` tells clones apart.
const enroll = (
  repos: ReadonlyArray<EnrolledRepoRoot>,
  checkout: Checkout,
  name: Option.Option<string>,
) => {
  const given = EnrolledRepoRoot.make({
    repo: checkout.repo,
    path: checkout.root,
    ...Option.match(name, { onNone: () => ({}), onSome: (label) => ({ name: label }) }),
    defaults: {},
    paused: false,
  });

  return Result.map(
    entryFor(repos, { repo: checkout.repo, name, path: checkout.root }),
    Option.match({
      onNone: () => ({ repo: given, added: true }),
      onSome: (index) => ({
        repo: reenroll(
          repos[index],
          EnrolledRepoRoot.make({ ...given, paused: repos[index].paused }),
        ),
        added: false,
      }),
    }),
  );
};

// The entry a checkout has among `repos`, if it's enrolled, under `name`
// among clones. A checkout without flows has nothing to enrol.
const entryOf = (
  repos: ReadonlyArray<EnrolledRepoRoot>,
  checkout: Checkout,
  name: Option.Option<string>,
): Result.Result<Option.Option<EnrolledRepoRoot>, NoFlows | AmbiguousClone> => {
  if (checkout.flows.length === 0) {
    return Result.fail(new NoFlows({ root: checkout.root }));
  }

  return Result.map(
    entryFor(repos, { repo: checkout.repo, name, path: checkout.root }),
    Option.map((index) => repos[index]),
  );
};

// Points an entry at its checkout's new place, keeping every setting.
const repoint = (repo: EnrolledRepoRoot, path: string) => EnrolledRepoRoot.make({ ...repo, path });

// Entries of `slug` whose checkout is gone, that a checkout at `root` could be.
const moved = (
  repos: ReadonlyArray<EnrolledRepoRoot>,
  slug: RepoSlug,
  root: string,
  exists: (path: string) => boolean,
) => repos.filter((repo) => repo.repo === slug && repo.path !== root && !exists(repo.path));

// A cron expression a person gave as a flow's schedule, or why it isn't one.
const checkSchedule = (schedule: Option.Option<string>) =>
  Option.match(schedule, {
    onNone: () => Result.succeed(schedule),
    onSome: (expression) =>
      Result.match(Cron.parse(expression), {
        onSuccess: () => Result.succeed(schedule),
        onFailure: (error) =>
          Result.fail(
            new InvalidSchedule({ message: `"${expression}" isn't a schedule: ${error.message}` }),
          ),
      }),
  });

// Why a persona's other accounts and roles' accounts would fail its runs,
// given its own account, if they would. Accounts are chosen by agent, so each
// of its other accounts runs another agent than its own account, and no two
// the same one; a role's account may be its own.
const accountsProblem = (
  own: PersonaEntry,
  main: OfferedAccount,
  find: (name: string) => Option.Option<OfferedAccount>,
  unknown: (name: string) => string,
) => {
  const agents: Array<string> = [];

  for (const name of own.accounts ?? []) {
    const picked = find(name);

    if (Option.isNone(picked)) {
      return Option.some(unknown(name));
    }

    if (picked.value.agent === main.agent) {
      return Option.some(
        `accounts names ${picked.value.name}, a ${picked.value.agent} account like the persona's own (${main.name}); list only accounts of other agents`,
      );
    }

    if (agents.includes(picked.value.agent)) {
      return Option.some(`accounts names two ${picked.value.agent} accounts; list one per agent`);
    }

    agents.push(picked.value.agent);
  }

  for (const [role, name] of Object.entries(own.roles ?? {})) {
    const picked = find(name);

    if (Option.isNone(picked)) {
      return Option.some(unknown(name));
    }

    if (picked.value.agent === main.agent && picked.value.name !== main.name) {
      return Option.some(
        `roles.${role} is ${picked.value.name}, a ${picked.value.agent} account like the persona's own (${main.name}); a role's account must run another agent`,
      );
    }
  }

  return Option.none<string>();
};

// The repo, unless a persona's accounts would fail its runs: one machine
// config doesn't have, or two on one agent.
const checkAccounts = (repo: EnrolledRepoRoot, persona: Persona, machine: MachineOffer) => {
  const own = choicesOf(repo, persona);

  const find = (name: string) =>
    Arr.findFirst(machine.accounts, (account) => account.name === name);

  const unknown = (name: string) =>
    `account "${name}" is not one of ${machine.accounts.map((known) => known.name).join(", ")}`;

  const mainName = Option.getOrElse(
    Option.orElse(Option.fromUndefinedOr(own.account), () =>
      Option.map(Arr.head(machine.accounts), (first) => first.name),
    ),
    () => "work",
  );

  const problem = Option.match(find(mainName), {
    onNone: () => Option.some(unknown(mainName)),
    onSome: (main) => accountsProblem(own, main, find, unknown),
  });

  return Option.match(problem, {
    onNone: () => Result.succeed(repo),
    onSome: (said) =>
      Result.fail(new AccountsClash({ message: `${repo.repo}${asSuffix(persona)}: ${said}` })),
  });
};

export const EnrolledRepoRootOps = {
  teamOff,
  agentsOf,
  unavailable,
  flowOffers,
  defaultFlows,
  currentFlows,
  currentPersonas,
  choosePersonas,
  chooseFlows,
  chooseAccounts,
  enrolPersonas,
  entryOf,
  enroll,
  repoint,
  moved,
  checkSchedule,
  checkAccounts,
  nameOf,
  choicesOf,
  entryFor,
  reenroll,
  ownFlows,
  setFlow,
  setFlowSchedule,
  setAccount,
  answersTo,
  named,
  pause,
  resume,
} as const;
