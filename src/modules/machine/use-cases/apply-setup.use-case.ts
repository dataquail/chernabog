import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  AccountAgentUnknown,
  AccountDirMissing,
} from "../domain/machine-setup/machine-setup.errors.ts";
import {
  MachineSetupRootOps,
  type NewAccount,
} from "../domain/machine-setup/machine-setup.root-ops.ts";
import { AccountDirsClient } from "../domain/ports/clients/account-dirs.client.ts";
import { GitHubLoginsClient } from "../domain/ports/clients/github-logins.client.ts";
import { MachineSetupsRepository } from "../domain/ports/repositories/machine-setups.repository.ts";
import { AddedAccount, SetupOutcome } from "./setup.result.ts";

// What a person chose, where they chose: none leaves the choice to the
// defaults, which are what a person would pick with nothing to weigh.
export type SetupAnswers = {
  // The GitHub logins to act as, replacing the ones there. None adds gh's
  // only login, when it has one, and leaves them otherwise.
  readonly personas: Option.Option<ReadonlyArray<string>>;
  // Account directories to add, each dir or dir:agent, ~ for the home. None
  // adds the one found, on a machine with no accounts yet, and none otherwise.
  readonly accounts: Option.Option<ReadonlyArray<string>>;
  // The logins enrolled repos run as, which the personas must keep.
  readonly inUse: ReadonlyArray<string>;
};

const parseAccount = (spec: string, home: string) =>
  Effect.gen(function* () {
    const [given, named] = spec.split(":");
    const dir = MachineSetupRootOps.expandHome(given.trim(), home);

    const agent = Option.orElse(Option.fromUndefinedOr(named), () =>
      MachineSetupRootOps.agentOfDir(dir),
    );

    if (Option.isNone(agent)) {
      return yield* new AccountAgentUnknown({ dir: given });
    }

    if (!(yield* (yield* AccountDirsClient).exists(dir))) {
      return yield* new AccountDirMissing({ dir: given });
    }

    return { dir, agent: agent.value } satisfies NewAccount;
  });

// Sets up the machine as a person chose: the GitHub personas it acts as, and
// the AI accounts its runs spend.
export const applySetupUseCase = Effect.fn("applySetupUseCase")(function* (answers: SetupAnswers) {
  const repository = yield* MachineSetupsRepository;
  const dirs = yield* AccountDirsClient;
  const home = yield* dirs.home;
  const before = yield* repository.findOne;
  const loggedIn = yield* (yield* GitHubLoginsClient).logins;

  const personas = yield* Option.match(answers.personas, {
    onSome: (chosen) =>
      Effect.fromResult(
        MachineSetupRootOps.choosePersonas(before, chosen, loggedIn, answers.inUse),
      ).pipe(Effect.asSome),
    onNone: () =>
      Effect.succeed(
        Option.map(
          Option.liftPredicate(loggedIn, (logins) => logins.length === 1),
          (only) => MachineSetupRootOps.addPersonas(before, only),
        ),
      ),
  });

  const known = MachineSetupRootOps.knownDirs(before, home);

  const specs = yield* Option.match(answers.accounts, {
    onSome: Effect.succeed,
    onNone: () =>
      dirs.found.pipe(
        Effect.map((found) => {
          const candidates = found.filter(
            (dir) => !known.includes(dir) && Option.isSome(MachineSetupRootOps.agentOfDir(dir)),
          );

          return Option.getOrElse(
            Option.liftPredicate(
              candidates,
              (only) => only.length === 1 && !before.accountsWritten,
            ),
            (): ReadonlyArray<string> => [],
          );
        }),
      ),
  });

  const adding = yield* Effect.forEach(specs, (spec) => parseAccount(spec, home));

  const { added, setup } = MachineSetupRootOps.addAccounts(
    Option.getOrElse(personas, () => before),
    adding,
    home,
  );

  yield* repository.save(setup);

  return SetupOutcome.make({
    personas: Option.map(personas, (chosen) => chosen.personas),
    before: before.personas,
    loggedIn,
    added: added.map((account) =>
      AddedAccount.make({
        name: account.name,
        display: Option.getOrElse(account.configDir, () => account.name),
        agent: account.agent,
      }),
    ),
  });
});
