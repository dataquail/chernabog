// Enrolling a repo on this machine, which `chernabog init` and `chernabog
// enroll` run: which personas work in it, which flows each one runs, and which
// accounts they spend. It asks only what it has to, and every answer has a
// flag, for scripts.

import * as Arr from "effect/Array";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Asker, type Choice } from "./ask.ts";
import { ConfigError } from "./config.ts";
import { viewerLogin } from "./GitHubApi.ts";
import { enrolmentOf } from "./init.ts";
import { flowNames } from "./loader.ts";
import { IMPLICIT, type Persona } from "./persona.ts";
import {
  choicesOf,
  type EnrolledRepo,
  enrollInMachineConfig,
  entryFor,
  loadMachineConfig,
  type MachineAccount,
  type MachineConfig,
  type PersonaEnrolment,
  readYaml,
  RepoConfigFile,
  repoNameOf,
  teamOff,
  writeEnrolment,
} from "./repo-config.ts";

export type EnrollOptions = {
  readonly account: Option.Option<ReadonlyArray<string>>;
  readonly name: Option.Option<string>;
  readonly personas: Option.Option<ReadonlyArray<string>>;
  readonly flows: Option.Option<ReadonlyArray<string>>;
  // The team's default flows, for every persona, without asking.
  readonly defaults: boolean;
};

const listed = (items: ReadonlyArray<string>) =>
  Option.getOrElse(
    Option.liftPredicate(items.join(", "), (text) => text.length > 0),
    () => "none",
  );

const who = (persona: Persona) => Option.getOrElse(persona, () => "this machine");

// A flow as enrolling offers it: on by the team's default, and whether this
// machine has an account for every agent it needs.
type FlowOffer = {
  readonly name: string;
  readonly teamDefault: boolean;
  readonly teamOff: Option.Option<string>;
  readonly unavailable: Option.Option<string>;
};

// The agents a flow runs: its own, its roles', and the repo's.
export const agentsOf = (team: RepoConfigFile, flow: string) =>
  Arr.dedupe([
    ...Option.toArray(Option.fromUndefinedOr(team.flows?.[flow]?.agent)),
    ...Object.values(team.flows?.[flow]?.agents ?? {}),
    ...Option.toArray(Option.fromUndefinedOr(team.agent)),
  ]);

// Why a flow can't run on this machine: an agent it needs has no account.
export const unavailable = (machine: MachineConfig, team: RepoConfigFile, flow: string) => {
  const missing = agentsOf(team, flow).filter(
    (agent) => !machine.accounts.some((account) => account.agent === agent),
  );

  return Option.map(
    Option.liftPredicate(missing, Arr.isReadonlyArrayNonEmpty),
    (agents) => `needs ${agents.join(" and ")}; add an account for each with chernabog setup`,
  );
};

// Which personas work in the repo: the ones named, else the only one, else the ones picked.
const choosePersonas = (
  machine: MachineConfig,
  entry: Option.Option<EnrolledRepo>,
  named: Option.Option<ReadonlyArray<string>>,
) =>
  Effect.gen(function* () {
    const asker = yield* Asker;
    const logins = machine.github;

    if (logins.length === 0) {
      if (Option.isSome(named)) {
        return yield* new ConfigError({
          message:
            "machine config lists no GitHub personas to choose from; add them with chernabog setup",
        });
      }

      return Arr.of(IMPLICIT);
    }

    const current = Option.flatMap(entry, (found) =>
      Option.map(Option.fromUndefinedOr(found.personas), Object.keys),
    );

    const chosen = yield* Option.match(named, {
      onSome: (names) => {
        const unknown = names.filter((login) => !logins.includes(login));

        if (unknown.length > 0) {
          return Effect.fail(
            new ConfigError({
              message: `${unknown.join(", ")} isn't one of machine config's GitHub personas (${logins.join(", ")}); add it with chernabog setup`,
            }),
          );
        }

        return Effect.succeed(Arr.dedupe(names));
      },
      onNone: () => {
        if (logins.length === 1) {
          return Effect.succeed(logins);
        }

        if (!asker.interactive) {
          return Effect.fromOption(current).pipe(
            Effect.mapError(
              () =>
                new ConfigError({
                  message: `machine config has several GitHub personas (${logins.join(", ")}); choose this repo's with --persona`,
                }),
            ),
          );
        }

        return asker.pick(
          "Which GitHub personas work in this repo?",
          logins.map((login): Choice => ({
            title: login,
            value: login,
            selected: Option.match(current, {
              onNone: () => true,
              onSome: (known) => known.includes(login),
            }),
          })),
        );
      },
    });

    if (!Arr.isReadonlyArrayNonEmpty(chosen)) {
      return yield* new ConfigError({ message: "choose at least one GitHub persona for the repo" });
    }

    return Arr.map(chosen, (login): Persona => Option.some(login));
  });

// The flows one persona runs: --defaults or --flows, else asked, with the
// team's defaults first, else the ones it lists already, else the defaults.
const chooseFlows = (
  persona: Persona,
  offers: ReadonlyArray<FlowOffer>,
  current: Option.Option<ReadonlyArray<string>>,
  options: EnrollOptions,
) =>
  Effect.gen(function* () {
    const asker = yield* Asker;

    const defaults = offers.flatMap((offer) =>
      Option.toArray(
        Option.liftPredicate(
          offer.name,
          () => offer.teamDefault && Option.isNone(offer.unavailable),
        ),
      ),
    );

    if (options.defaults) {
      return defaults;
    }

    if (Option.isSome(options.flows)) {
      for (const name of options.flows.value) {
        const offer = Arr.findFirst(offers, (candidate) => candidate.name === name);

        if (Option.isNone(offer)) {
          return yield* new ConfigError({
            message: `no flow named ${name} in .chernabog/flows/ (it has: ${listed(offers.map((known) => known.name))})`,
          });
        }

        for (const reason of Option.toArray(offer.value.unavailable)) {
          return yield* new ConfigError({ message: `${name} can't run here: it ${reason}` });
        }
      }

      return Arr.dedupe(options.flows.value);
    }

    if (!asker.interactive) {
      return Option.getOrElse(current, () => defaults);
    }

    const keep = Option.filter(current, (flows) => flows.join(",") !== defaults.join(","));

    const answer = yield* asker.choose(`Flows for ${who(persona)}`, [
      { title: `Accept the defaults (${listed(defaults)})`, value: "defaults" },
      ...Option.toArray(
        Option.map(keep, (flows): Choice => ({
          title: `Keep the current ones (${listed(flows)})`,
          value: "keep",
        })),
      ),
      { title: "Choose flows", value: "choose" },
    ]);

    if (answer === "defaults") {
      return defaults;
    }

    if (answer === "keep") {
      return Option.getOrElse(current, () => defaults);
    }

    const selected = Option.getOrElse(current, () => defaults);

    const picked = yield* asker.pick(
      `Which flows should run as ${who(persona)}?`,
      offers.map((offer): Choice => ({
        title: offer.name,
        value: offer.name,
        selected: selected.includes(offer.name) && Option.isNone(offer.unavailable),
        disabled: Option.isSome(offer.unavailable),
        ...Option.match(
          Option.orElse(offer.unavailable, () => offer.teamOff),
          { onNone: () => ({}), onSome: (description) => ({ description }) },
        ),
      })),
    );

    return picked.filter((name) =>
      offers.some((offer) => offer.name === name && Option.isNone(offer.unavailable)),
    );
  });

// One account of `candidates`: the one named, else the only one, else asked,
// else the one chosen before, else the first.
const chooseAccount = (
  message: string,
  candidates: Arr.NonEmptyReadonlyArray<MachineAccount>,
  named: ReadonlyArray<string>,
  current: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const asker = yield* Asker;
    const flagged = Arr.findFirst(candidates, (account) => named.includes(account.name));

    if (Option.isSome(flagged)) {
      return flagged.value;
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    const before = Option.getOrElse(
      Arr.findFirst(candidates, (account) => current.includes(account.name)),
      () => candidates[0],
    );

    if (!asker.interactive) {
      return before;
    }

    // The one chosen before goes first, so enter keeps it.
    const ordered = [before, ...candidates.filter((account) => account.name !== before.name)];

    const name = yield* asker.choose(
      message,
      ordered.map((account): Choice => ({
        title: account.name,
        value: account.name,
        description: account.agent,
      })),
    );

    return Option.getOrElse(
      Arr.findFirst(candidates, (account) => account.name === name),
      () => before,
    );
  });

// The accounts one persona spends: its own, for the repo's agent, and one for
// each other agent its flows need where there's a choice.
const chooseAccounts = (
  machine: MachineConfig,
  team: RepoConfigFile,
  persona: Persona,
  flows: ReadonlyArray<string>,
  own: { readonly account: Option.Option<string>; readonly accounts: ReadonlyArray<string> },
  named: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const forAgent = (agent: string) =>
      machine.accounts.filter((account) => account.agent === agent);

    const base = Option.match(Option.fromUndefinedOr(team.agent), {
      onNone: () => machine.accounts,
      onSome: forAgent,
    });

    if (!Arr.isReadonlyArrayNonEmpty(base)) {
      return yield* new ConfigError({
        message: `no account for ${team.agent ?? "any agent"} in machine config; add one with chernabog setup`,
      });
    }

    const main = yield* chooseAccount(
      `Which account should ${who(persona)}'s runs spend?`,
      base,
      named,
      Option.toArray(own.account),
    );

    const others: Array<string> = [];

    for (const agent of Arr.dedupe(flows.flatMap((flow) => agentsOf(team, flow))).filter(
      (needed) => needed !== main.agent,
    )) {
      const candidates = forAgent(agent);

      if (!Arr.isReadonlyArrayNonEmpty(candidates) || candidates.length < 2) {
        continue;
      }

      others.push(
        (yield* chooseAccount(
          `Which ${agent} account should ${who(persona)}'s ${agent} steps spend?`,
          candidates,
          named,
          own.accounts,
        )).name,
      );
    }

    const unknown = named.filter(
      (name) => !machine.accounts.some((account) => account.name === name),
    );

    if (unknown.length > 0) {
      return yield* new ConfigError({
        message: `no account named ${unknown.join(", ")} in machine config (it has: ${listed(machine.accounts.map((account) => account.name))})`,
      });
    }

    return {
      account: Option.liftPredicate(main.name, () => machine.accounts.length > 1),
      accounts: others,
    };
  });

// Enrolls the repo a checkout is in, asking what it has to, and says what it chose.
export const enrollRepo = (path: string, options: EnrollOptions) =>
  Effect.gen(function* () {
    const repo = yield* enrolmentOf(path, { account: Option.none(), name: options.name });
    const root = repo.path;
    const machine = yield* loadMachineConfig;
    const entry = Option.map(yield* entryFor(machine.repos, repo), (found) => found.entry);
    const names = yield* flowNames(`${root}/.chernabog`);

    if (names.length === 0) {
      return yield* new ConfigError({
        message: `${root}: no flows in .chernabog/flows/; run chernabog init here first`,
      });
    }

    const team = yield* readYaml(RepoConfigFile, `${root}/.chernabog/config.yaml`);
    const personas = yield* choosePersonas(machine, entry, options.personas);

    // Who the implicit persona is matters only for the team's runners, so it's asked once, and only then.
    const self = yield* Cache.make({
      capacity: 1,
      lookup: () => Effect.map(Effect.option(viewerLogin), Option.toArray),
    });

    const named = Option.getOrElse(options.account, (): ReadonlyArray<string> => []);
    const chosen: Array<PersonaEnrolment> = [];

    for (const persona of personas) {
      const logins = yield* Option.match(persona, {
        onSome: (login) => Effect.succeed([login]),
        onNone: () => Cache.get(self, "login"),
      });

      const offers = names.map((name): FlowOffer => {
        const off = teamOff(team, name, logins);

        return {
          name,
          teamDefault: Option.isNone(off),
          teamOff: off,
          unavailable: unavailable(machine, team, name),
        };
      });

      const own = Option.map(entry, (found) => choicesOf(found, persona));

      const current = Option.flatMap(own, (found) =>
        Option.map(Option.fromUndefinedOr(found.flows), (flows) =>
          Object.entries(flows).flatMap(([flow, settings]) =>
            Option.toArray(Option.liftPredicate(flow, () => settings.enabled !== false)),
          ),
        ),
      );

      const flows = yield* chooseFlows(persona, offers, current, options);

      const accounts = yield* chooseAccounts(
        machine,
        team,
        persona,
        flows,
        {
          account: Option.flatMap(own, (found) => Option.fromUndefinedOr(found.account)),
          accounts: Option.getOrElse(
            Option.flatMap(own, (found) => Option.fromUndefinedOr(found.accounts)),
            (): ReadonlyArray<string> => [],
          ),
        },
        named,
      );

      chosen.push({ persona, flows, ...accounts });
    }

    const action = yield* enrollInMachineConfig(repo);

    // Several personas each keep their own choices; one runs from the repo's entry.
    const perPersona =
      machine.github.length > 1 ||
      Option.exists(entry, (found) => Option.isSome(Option.fromUndefinedOr(found.personas)));

    yield* writeEnrolment(repo, chosen, perPersona);

    return {
      repo,
      action,
      lines: chosen.map(({ account, accounts, flows, persona }) => {
        const spends = Option.match(account, {
          onNone: () => "",
          onSome: (name) => `; account ${[name, ...accounts].join(", ")}`,
        });

        return `${repoNameOf(repo)} as ${who(persona)}: flows ${listed(flows)}${spends}`;
      }),
    };
  });
