import * as Arr from "effect/Array";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type Persona } from "../../../kernel/persona.value-object.ts";
import { EnrollmentQueries } from "../../../modules/enrollment/enrollment.query-handlers.ts";
import {
  type EnrollmentPlan,
  type PersonaPlan,
} from "../../../modules/enrollment/queries/plan-enrollment.query.ts";
import { applyEnrollmentUseCase } from "../../../modules/enrollment/use-cases/apply-enrollment.use-case.ts";
import { type Enrolled } from "../../../modules/enrollment/use-cases/enrollment.result.ts";
import { MachineQueries } from "../../../modules/machine/machine.query-handlers.ts";
import { Home, homePaths } from "../../../platform/home.ts";
import { daemonReload } from "../../daemon/daemon.client.ts";
import { Asker, type Choice } from "../asker.prompt.ts";
import { printLines } from "../cli.output.ts";
import { listed, listFlag } from "../list.arguments.ts";

export const enrollFlags = {
  account: listFlag(
    "account",
    "Accounts from machine config to spend, comma-separated: the persona's own, and one for each other agent its flows need. Asked in a terminal where there's a choice",
  ),
  name: Flag.String("name").pipe(
    Flag.withDescription("A short name, when two enrolled repos share one"),
    Flag.optional,
  ),
  persona: listFlag(
    "persona",
    "The GitHub personas that work in this repo, comma-separated. Asked in a terminal when machine config has several",
  ),
  flows: listFlag(
    "flows",
    "The flows to run, comma-separated, for every chosen persona. Asked in a terminal for each persona",
  ),
  defaults: Flag.Boolean("defaults").pipe(
    Flag.withDescription("Run the team's default flows for every chosen persona, without asking"),
    Flag.withDefault(false),
  ),
};

export type EnrollFlags = {
  readonly account: Option.Option<ReadonlyArray<string>>;
  readonly name: Option.Option<string>;
  readonly persona: Option.Option<ReadonlyArray<string>>;
  readonly flows: Option.Option<ReadonlyArray<string>>;
  readonly defaults: boolean;
};

const who = (persona: Persona) => Option.getOrElse(persona, () => "this machine");

// Which personas work in the repo, when there's a choice and a person to make it.
const askPersonas = (plan: EnrollmentPlan) =>
  Effect.gen(function* () {
    const asker = yield* Asker;

    if (!asker.interactive || plan.logins.length < 2) {
      return Option.none<ReadonlyArray<string>>();
    }

    return Option.some(
      yield* asker.pick(
        "Which GitHub personas work in this repo?",
        plan.logins.map((login): Choice => ({
          title: login,
          value: login,
          selected: Option.match(plan.currentPersonas, {
            onNone: () => true,
            onSome: (known) => known.includes(login),
          }),
        })),
      ),
    );
  });

// The flows a person picks for one persona: the defaults, the ones it has, or
// a list of their own.
const askFlows = (own: PersonaPlan) =>
  Effect.gen(function* () {
    const asker = yield* Asker;
    const keep = Option.filter(own.current, (flows) => flows.join(",") !== own.defaults.join(","));

    const answer = yield* asker.choose(`Flows for ${who(own.persona)}`, [
      { title: `Accept the defaults (${listed(own.defaults)})`, value: "defaults" },
      ...Option.toArray(
        Option.map(keep, (flows): Choice => ({
          title: `Keep the current ones (${listed(flows)})`,
          value: "keep",
        })),
      ),
      { title: "Choose flows", value: "choose" },
    ]);

    if (answer === "defaults") {
      return own.defaults;
    }

    const selected = Option.getOrElse(own.current, () => own.defaults);

    if (answer === "keep") {
      return selected;
    }

    const picked = yield* asker.pick(
      `Which flows should run as ${who(own.persona)}?`,
      own.offers.map((offer): Choice => ({
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
      own.offers.some((offer) => offer.name === name && Option.isNone(offer.unavailable)),
    );
  });

type Account = EnrollmentPlan["accounts"][number];

// One account of `candidates`, asked of a person unless a flag named one or
// there's only one; the one chosen before goes first, so enter keeps it.
const askAccount = (
  message: string,
  candidates: ReadonlyArray<Account>,
  named: ReadonlyArray<string>,
  current: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const flagged = Arr.findFirst(candidates, (account) => named.includes(account.name));

    if (Option.isSome(flagged) || !Arr.isReadonlyArrayNonEmpty(candidates)) {
      return Option.orElse(flagged, () => Arr.head(candidates));
    }

    if (candidates.length === 1) {
      return Arr.head(candidates);
    }

    const before = Option.getOrElse(
      Arr.findFirst(candidates, (account) => current.includes(account.name)),
      () => candidates[0],
    );

    const ordered = [before, ...candidates.filter((account) => account.name !== before.name)];

    const name = yield* (yield* Asker).choose(
      message,
      ordered.map((account): Choice => ({
        title: account.name,
        value: account.name,
        description: account.agent,
      })),
    );

    return Arr.findFirst(candidates, (account) => account.name === name);
  });

// The accounts a person picks for one persona: its own, for the repo's agent,
// and one for each other agent its flows need where there's a choice.
const askAccounts = (
  plan: EnrollmentPlan,
  own: PersonaPlan,
  flows: ReadonlyArray<string>,
  named: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const base = Option.match(plan.teamAgent, {
      onNone: () => plan.accounts,
      onSome: (agent) => plan.accounts.filter((account) => account.agent === agent),
    });

    const main = yield* askAccount(
      `Which account should ${who(own.persona)}'s runs spend?`,
      base,
      named,
      Option.toArray(own.account),
    );

    const picked = Option.toArray(main).map((account) => account.name);

    const agents = Arr.dedupe(flows.flatMap((flow) => plan.agentsByFlow[flow] ?? [])).filter(
      (agent) => !Option.exists(main, (account) => account.agent === agent),
    );

    for (const agent of agents) {
      const candidates = plan.accounts.filter((account) => account.agent === agent);

      if (candidates.length < 2) {
        continue;
      }

      const other = yield* askAccount(
        `Which ${agent} account should ${who(own.persona)}'s ${agent} steps spend?`,
        candidates,
        named,
        own.accounts,
      );

      for (const account of Option.toArray(other)) {
        picked.push(account.name);
      }
    }

    return picked;
  });

// The plan's personas the person is asked about: the ones chosen, else the
// machine's only one.
const askedAbout = (plan: EnrollmentPlan, personas: Option.Option<ReadonlyArray<string>>) =>
  Option.match(personas, {
    onSome: (names) =>
      plan.personas.filter((own) => Option.exists(own.persona, (login) => names.includes(login))),
    onNone: () =>
      Option.getOrElse(
        Option.liftPredicate(plan.personas, () => plan.logins.length < 2),
        (): ReadonlyArray<PersonaPlan> => [],
      ),
  });

const describeEnrolled = (enrolled: Enrolled) =>
  enrolled.chosen.map(({ account, accounts, flows, persona }) => {
    const spends = Option.match(account, {
      onNone: () => "",
      onSome: (name) => `; account ${[name, ...accounts].join(", ")}`,
    });

    return `${enrolled.name} as ${who(persona)}: flows ${listed(flows)}${spends}`;
  });

// Enrolls the checkout at `root`, asking in a terminal what the flags don't
// say, and returns what it chose and the lines that say so.
export const enrollCheckout = (root: string, flags: EnrollFlags) =>
  Effect.gen(function* () {
    const asker = yield* Asker;
    const machine = yield* (yield* MachineQueries).ReadMachineSetupQuery();

    const plan = yield* (yield* EnrollmentQueries).PlanEnrollmentQuery({
      path: root,
      name: flags.name,
      offered: machine,
    });

    const personas = yield* Option.match(flags.persona, {
      onSome: (named) => Effect.succeedSome(named),
      onNone: () => askPersonas(plan),
    });

    const named = Option.getOrElse(flags.account, (): ReadonlyArray<string> => []);

    const asked: Array<{
      persona: Persona;
      flows: Option.Option<ReadonlyArray<string>>;
      accounts: ReadonlyArray<string>;
    }> = [];

    if (asker.interactive) {
      for (const own of askedAbout(plan, personas)) {
        const flows = yield* Option.match(
          Option.liftPredicate(own, () => !flags.defaults && Option.isNone(flags.flows)),
          {
            onNone: () => Effect.succeedNone,
            onSome: (persona) => askFlows(persona).pipe(Effect.asSome),
          },
        );

        const chosenFlows = Option.getOrElse(
          Option.orElse(flows, () =>
            Option.orElse(flags.flows, () =>
              Option.liftPredicate(own.defaults, () => flags.defaults),
            ),
          ),
          () => Option.getOrElse(own.current, () => own.defaults),
        );

        asked.push({
          persona: own.persona,
          flows,
          accounts: yield* askAccounts(plan, own, chosenFlows, named),
        });
      }
    }

    const enrolled = yield* applyEnrollmentUseCase(root, flags.name, machine, {
      personas,
      flows: Option.orElse(
        Option.map(flags.flows, (flows) => ({ flows })),
        () => Option.liftPredicate({ defaults: true } as const, () => flags.defaults),
      ),
      accounts: named,
      asked,
    });

    return { enrolled, lines: describeEnrolled(enrolled) };
  });

// Enrolls the repo at `root` and says what it chose. A running daemon
// restarts to schedule it; none running is fine.
export const enrollHere = (root: string, flags: EnrollFlags) =>
  Effect.gen(function* () {
    const { enrolled, lines } = yield* enrollCheckout(root, flags);
    const file = homePaths((yield* Home).root).machineConfig;

    const action = Option.match(
      Option.liftPredicate("added", () => enrolled.added),
      {
        onNone: () => "updated",
        onSome: (added) => added,
      },
    );

    yield* Console.log(`${action} ${enrolled.repo} (${enrolled.path}) in ${file}`);
    yield* printLines(lines);
    yield* daemonReload.pipe(Effect.ignore);

    return enrolled;
  });

// The repo a path is in; the working directory's when none is given.
export const rootOf = (path: Option.Option<string>) =>
  Effect.gen(function* () {
    const found = yield* (yield* EnrollmentQueries).FindCheckoutRootQuery({
      path: Option.getOrElse(path, () => "."),
    });

    return found.root;
  });

export const enrollCommand = Command.make(
  "enroll",
  { path: Argument.String("path").pipe(Argument.optional), ...enrollFlags },
  ({ path, ...flags }) =>
    Effect.gen(function* () {
      const enrolled = yield* enrollHere(yield* rootOf(path), flags);
      yield* Console.log(`Next: chernabog trust ${enrolled.name}`);
    }),
).pipe(
  Command.withDescription(
    "Add a repo to this machine's config: which personas work in it, which flows each runs, and which accounts they spend",
  ),
);
