import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { EnrollmentQueries } from "../../../modules/enrollment/enrollment.query-handlers.ts";
import { MachineQueries } from "../../../modules/machine/machine.query-handlers.ts";
import { type SetupPlan } from "../../../modules/machine/queries/plan-setup.query.ts";
import { applySetupUseCase } from "../../../modules/machine/use-cases/apply-setup.use-case.ts";
import { type SetupOutcome } from "../../../modules/machine/use-cases/setup.result.ts";
import { Asker } from "../asker.prompt.ts";
import { printLines } from "../cli.output.ts";
import { listed, listFlag } from "../list.arguments.ts";

export const setupFlags = {
  persona: listFlag(
    "persona",
    "The GitHub logins to act as, comma-separated, from gh auth status. Asked in a terminal when gh has several; the only one otherwise",
  ),
  account: listFlag(
    "account",
    "AI account directories to add, comma-separated, each dir or dir:agent, such as ~/.claude-personal. Found ones are asked about in a terminal",
  ),
};

export type SetupFlags = {
  readonly persona: Option.Option<ReadonlyArray<string>>;
  readonly account: Option.Option<ReadonlyArray<string>>;
};

// Which of gh's logins to act as, when gh has several to choose from.
const askPersonas = (plan: SetupPlan) =>
  Effect.gen(function* () {
    const asker = yield* Asker;

    if (plan.loggedIn.length < 2 || !asker.interactive) {
      return Option.none<ReadonlyArray<string>>();
    }

    const current = Option.liftPredicate(plan.personas, (chosen) => chosen.length > 0);

    return Option.some(
      yield* asker.pick(
        "Which GitHub accounts should chernabog act as?",
        plan.loggedIn.map((login) => ({
          title: login,
          value: login,
          selected: Option.match(current, {
            onNone: () => true,
            onSome: (chosen) => chosen.includes(login),
          }),
        })),
      ),
    );
  });

// Asks for accounts setup didn't find, such as ~/.claude-personal behind an
// alias, until none is given; each as dir:agent.
const askForMore = Effect.gen(function* () {
  const asker = yield* Asker;
  const more: Array<string> = [];

  for (;;) {
    const answer = (yield* asker.text(
      "Another account's config directory, such as ~/.claude-personal behind an alias (enter when done)",
    )).trim();

    if (answer.length === 0) {
      return more;
    }

    const found = yield* (yield* MachineQueries).InspectAccountDirQuery({ typed: answer });

    const agent = yield* Option.match(found.agent, {
      onSome: Effect.succeed,
      onNone: () =>
        asker.choose(
          `Which agent is ${answer} for?`,
          ["claude", "codex", "opencode"].map((name) => ({ title: name, value: name })),
        ),
    });

    more.push(`${found.dir}:${agent}`);
  }
});

// Which of the account directories found to add, and any it didn't find.
const askAccounts = (plan: SetupPlan) =>
  Effect.gen(function* () {
    const asker = yield* Asker;

    if (!asker.interactive) {
      return Option.none<ReadonlyArray<string>>();
    }

    let picked: ReadonlyArray<string> = [];

    if (plan.candidates.length > 0) {
      picked = yield* asker.pick(
        "Which of these AI accounts should chernabog use?",
        plan.candidates.map((candidate) => ({
          title: candidate.display,
          value: candidate.dir,
          description: Option.getOrElse(candidate.agent, () => ""),
          selected: true,
        })),
      );
    }

    return Option.some([...picked, ...(yield* askForMore)]);
  });

const describeSetup = (outcome: SetupOutcome) => [
  Option.match(outcome.personas, {
    onSome: (chosen) => `GitHub personas: ${chosen.join(", ")}`,
    onNone: () => {
      if (outcome.loggedIn.length === 0) {
        return "gh is logged in to no GitHub account; runs act as GH_TOKEN, or gh's active account";
      }

      return `GitHub personas: ${listed(outcome.before)} (unchanged; gh is logged in as ${outcome.loggedIn.join(", ")}: choose with --persona)`;
    },
  }),
  `AI accounts added: ${listed(outcome.added.map((added) => `${added.name} (${added.display}, ${added.agent})`))}`,
];

// Sets the machine up as the flags say, asking in a terminal what they
// don't, and says what it chose.
export const setUpMachine = (flags: SetupFlags) =>
  Effect.gen(function* () {
    const plan = yield* (yield* MachineQueries).PlanSetupQuery();

    const personas = yield* Option.match(flags.persona, {
      onSome: (named) => Effect.succeedSome(named),
      onNone: () => askPersonas(plan),
    });

    const accounts = yield* Option.match(flags.account, {
      onSome: (named) => Effect.succeedSome(named),
      onNone: () => askAccounts(plan),
    });

    const outcome = yield* applySetupUseCase({
      personas,
      accounts,
      inUse: (yield* (yield* EnrollmentQueries).ListPersonasInUseQuery()).logins,
    });

    return describeSetup(outcome);
  });

export const setupCommand = Command.make("setup", setupFlags, (flags) =>
  Effect.flatMap(setUpMachine(flags), printLines),
).pipe(
  Command.withDescription(
    "Choose the GitHub personas this machine acts as and the AI accounts its runs spend; safe to run again",
  ),
);
