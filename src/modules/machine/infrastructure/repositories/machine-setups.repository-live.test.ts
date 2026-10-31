import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { effectAtHome } from "../../../../../test/effect-test.ts";
import { Home, homePaths } from "../../../../platform/home.ts";
import { MachineAccount } from "../../domain/machine-setup/machine-account.value-object.ts";
import { MachineSetupRoot } from "../../domain/machine-setup/machine-setup.root.ts";
import { MachineSetupSpecifications } from "../../domain/machine-setup/machine-setup.specification.ts";
import { MachineSetupsRepository } from "../../domain/machine-setup/machine-setups.repository.ts";
import { MachineSetupsRepositoryLive } from "./machine-setups.repository-live.ts";

const opened = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = homePaths((yield* Home).root).machineConfig;

  return { fs, file, setups: yield* MachineSetupsRepository };
}).pipe(Effect.provide(MachineSetupsRepositoryLive));

const account = (name: string, agent: string, configDir: Option.Option<string>) =>
  MachineAccount.make({ name, agent, configDir });

describe("MachineSetupsRepositoryLive", () => {
  effectAtHome(
    "reads a machine with no config as one with no personas and no accounts written",
    () =>
      Effect.gen(function* () {
        const { setups } = yield* opened;

        expect(yield* setups.findOne(MachineSetupSpecifications.thisMachine)).toEqual(
          Option.some(
            MachineSetupRoot.make({ personas: [], accounts: [], accountsWritten: false }),
          ),
        );
      }),
  );

  effectAtHome("saves personas and added accounts in place, keeping comments and the rest", () =>
    Effect.gen(function* () {
      const { file, fs, setups } = yield* opened;
      yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
      yield* fs.writeFileString(
        file,
        [
          "# my machine",
          "github:",
          "  alice: {}",
          "accounts:",
          "  work:",
          "    expectedEmail: me@example.com # checked by doctor",
          "concurrency: 2",
          "",
        ].join("\n"),
      );

      const before = Option.getOrThrow(
        yield* setups.findOne(MachineSetupSpecifications.thisMachine),
      );

      expect(before.accounts).toEqual([account("work", "claude", Option.none())]);

      yield* setups.upsertOne(
        MachineSetupRoot.make({
          ...before,
          personas: ["bob"],
          accounts: [
            ...before.accounts,
            account("codex", "codex", Option.some("~/.codex")),
            account("claude-personal", "claude", Option.some("~/.claude-personal")),
          ],
        }),
      );

      expect(yield* fs.readFileString(file)).toBe(
        [
          "# my machine",
          "github:",
          "  bob: {}",
          "accounts:",
          "  work:",
          "    expectedEmail: me@example.com # checked by doctor",
          "  codex:",
          "    configDir: ~/.codex",
          "    agent: codex",
          "  claude-personal:",
          "    configDir: ~/.claude-personal",
          "concurrency: 2",
          "",
        ].join("\n"),
      );
    }),
  );
});
