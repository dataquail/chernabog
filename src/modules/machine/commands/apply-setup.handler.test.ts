import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { MachineAccount } from "../domain/machine-setup/machine-account.value-object.ts";
import { MachineSetupRoot } from "../domain/machine-setup/machine-setup.root.ts";
import { MachineSetupSpecifications } from "../domain/machine-setup/machine-setup.specification.ts";
import { MachineSetupsRepository } from "../domain/machine-setup/machine-setups.repository.ts";
import { AccountDirsClientFake } from "../infrastructure/clients/account-dirs.client-fake.ts";
import { GitHubLoginsClientFake } from "../infrastructure/clients/github-logins.client-fake.ts";
import { MachineSetupsRepositoryFake } from "../infrastructure/repositories/machine-setups.repository-fake.ts";
import { applySetupHandler } from "./apply-setup.handler.ts";

const HOME = "/home/zw";

const setupOf = (personas: ReadonlyArray<string>, accounts: ReadonlyArray<MachineAccount>) =>
  MachineSetupRoot.make({ personas, accounts, accountsWritten: accounts.length > 0 });

const work = MachineAccount.make({ name: "work", agent: "claude", configDir: Option.none() });

const machine = (
  setup: MachineSetupRoot,
  logins: ReadonlyArray<string>,
  dirs: ReadonlyArray<string>,
) =>
  Layer.mergeAll(
    MachineSetupsRepositoryFake(setup),
    GitHubLoginsClientFake(logins),
    AccountDirsClientFake(
      HOME,
      dirs.map((dir) => `${HOME}/${dir}`),
    ),
  );

const stored = MachineSetupsRepository.use((repository) =>
  repository.findOne(MachineSetupSpecifications.thisMachine).pipe(Effect.map(Option.getOrThrow)),
);

const none = { personas: Option.none(), accounts: Option.none(), inUse: [] };

describe("applySetupHandler", () => {
  effect("one gh login and one account found are chosen without asking, keeping work", () =>
    Effect.gen(function* () {
      const outcome = yield* applySetupHandler(none);
      const setup = yield* stored;

      expect(outcome.personas).toEqual(Option.some(["alice"]));
      expect(outcome.added.map((added) => [added.name, added.display, added.agent])).toEqual([
        ["codex", "~/.codex", "codex"],
      ]);
      expect(setup.accounts.map((account) => account.name)).toEqual(["work", "codex"]);
    }).pipe(Effect.provide(machine(setupOf([], []), ["alice"], [".codex", "code"]))),
  );

  effect(
    "the only gh login joins the personas there, and an account found isn't added to accounts written",
    () =>
      Effect.gen(function* () {
        const outcome = yield* applySetupHandler(none);

        expect(outcome.personas).toEqual(Option.some(["bob", "alice"]));
        expect(outcome.added).toEqual([]);
      }).pipe(Effect.provide(machine(setupOf(["bob"], [work]), ["alice"], [".codex"]))),
  );

  effect("several gh logins and none chosen leave the personas as they were", () =>
    Effect.gen(function* () {
      const outcome = yield* applySetupHandler(none);

      expect([outcome.personas, outcome.before, outcome.loggedIn]).toEqual([
        Option.none(),
        ["bob"],
        ["alice", "bob"],
      ]);
    }).pipe(Effect.provide(machine(setupOf(["bob"], [work]), ["alice", "bob"], []))),
  );

  effect("chosen personas and accounts replace and add, keeping a persona a repo runs as", () =>
    Effect.gen(function* () {
      const dropped = yield* Effect.flip(
        applySetupHandler({ ...none, personas: Option.some(["alice"]), inUse: ["bob"] }),
      );

      expect(dropped._tag).toBe("PersonaStillInUse");

      yield* applySetupHandler({
        personas: Option.some(["bob"]),
        accounts: Option.some(["~/.claude-personal", "~/elsewhere/.work-claude:claude"]),
        inUse: ["bob"],
      });
      const setup = yield* stored;

      expect(setup.personas).toEqual(["bob"]);
      expect(setup.accounts.map((account) => [account.name, account.configDir])).toEqual([
        ["work", Option.none()],
        ["claude-personal", Option.some("~/.claude-personal")],
        ["work-claude", Option.some("~/elsewhere/.work-claude")],
      ]);
    }).pipe(
      Effect.provide(
        machine(
          setupOf(["alice", "bob"], [work]),
          ["alice", "bob"],
          [".claude-personal", "elsewhere/.work-claude"],
        ),
      ),
    ),
  );

  effect("an account directory that isn't there, or whose agent nothing says, is refused", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.flip(
        applySetupHandler({ ...none, accounts: Option.some(["~/.claude-gone"]) }),
      );

      const untold = yield* Effect.flip(
        applySetupHandler({ ...none, accounts: Option.some(["~/logins"]) }),
      );

      expect(missing.message).toBe(
        "~/.claude-gone doesn't exist; log in to the agent with it first",
      );
      expect(untold.message).toBe(
        "can't tell which agent ~/logins belongs to; name it as ~/logins:<agent>, such as ~/logins:claude",
      );
    }).pipe(Effect.provide(machine(setupOf([], [work]), [], ["logins"]))),
  );
});
