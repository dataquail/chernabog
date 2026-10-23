import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { MachineAccount } from "./machine-account.value-object.ts";
import { MachineSetupRoot } from "./machine-setup.root.ts";
import { MachineSetupRootOps } from "./machine-setup.root-ops.ts";

const home = "/home/zw";

const bare = MachineSetupRoot.make({ personas: [], accounts: [], accountsWritten: false });

const account = (name: string, agent: string, configDir: Option.Option<string>) =>
  MachineAccount.make({ name, agent, configDir });

describe("MachineSetupRootOps account directories", () => {
  test("a directory's name says its agent, and home spells it with ~", () => {
    expect(MachineSetupRootOps.agentOfDir("/home/zw/.claude-personal")).toEqual(
      Option.some("claude"),
    );
    expect(MachineSetupRootOps.agentOfDir("/elsewhere/codex-work/")).toEqual(Option.some("codex"));
    expect(MachineSetupRootOps.agentOfDir("/home/zw/code")).toEqual(Option.none());
    expect(MachineSetupRootOps.homeRelative("/home/zw/.codex", home)).toBe("~/.codex");
    expect(MachineSetupRootOps.homeRelative("/opt/.codex", home)).toBe("/opt/.codex");
    expect(MachineSetupRootOps.expandHome("~/.codex", home)).toBe("/home/zw/.codex");
  });

  test("an account without a directory keeps its agent's default one", () => {
    const setup = MachineSetupRoot.make({
      personas: [],
      accounts: [
        account("work", "claude", Option.none()),
        account("personal", "claude", Option.some("~/.claude-personal")),
        account("mine", "opencode", Option.none()),
      ],
      accountsWritten: true,
    });

    expect(MachineSetupRootOps.knownDirs(setup, home)).toEqual([
      "/home/zw/.claude",
      "/home/zw/.claude-personal",
    ]);
  });
});

describe("MachineSetupRootOps.addAccounts", () => {
  test("names each for its directory, keeping the default work account a machine had", () => {
    const { added, setup } = MachineSetupRootOps.addAccounts(
      bare,
      [
        { dir: "/home/zw/.codex", agent: "codex" },
        { dir: "/home/zw/a/.codex", agent: "codex" },
      ],
      home,
    );

    expect(setup.accounts.map((found) => [found.name, found.agent, found.configDir])).toEqual([
      ["work", "claude", Option.none()],
      ["codex", "codex", Option.some("~/.codex")],
      ["codex-2", "codex", Option.some("~/a/.codex")],
    ]);
    expect(added.map((found) => found.name)).toEqual(["codex", "codex-2"]);
    expect(setup.accountsWritten).toBe(true);
  });

  test("adding none changes nothing, not even writing the default account", () => {
    expect(MachineSetupRootOps.addAccounts(bare, [], home).setup).toEqual(bare);
  });
});

describe("MachineSetupRootOps personas", () => {
  const setup = MachineSetupRoot.make({ ...bare, personas: ["alice", "bob"] });

  test("chosen ones replace the rest, unless a repo still runs as one dropped", () => {
    expect(
      Result.map(
        MachineSetupRootOps.choosePersonas(setup, ["bob"], ["alice", "bob"], ["bob"]),
        (chosen) => chosen.personas,
      ),
    ).toEqual(Result.succeed(["bob"]));

    const stranded = MachineSetupRootOps.choosePersonas(
      setup,
      ["alice"],
      ["alice", "bob"],
      ["bob"],
    );

    expect(Result.isFailure(stranded) && stranded.failure.message).toBe(
      "enrolled repos still run as bob; keep those personas, or chernabog unenroll the repos first",
    );
  });

  test("a chosen login gh isn't logged in as is refused", () => {
    const unknown = MachineSetupRootOps.choosePersonas(setup, ["mallory"], ["alice"], []);

    expect(Result.isFailure(unknown) && unknown.failure.message).toBe(
      "gh isn't logged in to github.com as mallory (it is as: alice); gh auth login as each first",
    );
  });

  test("an added login joins the ones there, dropping none", () => {
    expect(MachineSetupRootOps.addPersonas(setup, ["carol", "bob"]).personas).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
  });
});
