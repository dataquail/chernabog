// The machine the live driver (test/features/drivers/live.ts) runs on: a
// clone of a real scratch repo, a chernabog home whose machine config the
// driver writes, the fake claude, codex and tmux of test/fakebin/ on PATH
// (and the real gh, with the person's logins), and the CLI and daemon
// pointed at all of it. It is to the live driver what sandbox.ts is to the
// sandbox driver, without a fake GitHub: GitHub is the real one.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DaemonStatus } from "../../src/interface/daemon/daemon.protocol.ts";
import { gitCredentialEnv } from "../../src/platform/github-auth.ts";
import { type CliResult, closed, gitConfigIn, waitFor } from "./sandbox.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// The fake agents and the fake tmux they run under, and nothing else of
// test/fakebin/: gh is the real one.
const FAKES = ["claude", "codex", "tmux"];

// What chernabog must not inherit: an ambient token, which would act as the
// wrong login, and anything pointing it anywhere but GitHub and Anthropic.
const UNSET = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_ACTIONS",
  "CHERNABOG_GITHUB_API",
  "CHERNABOG_USAGE_URL",
  "CHERNABOG_HOME",
  "ANTHROPIC_API_KEY",
];

// gh's own config, where the person's logins are, wherever XDG_CONFIG_HOME
// moves to.
const ghConfigDir = () =>
  Option.getOrElse(Option.fromUndefinedOr(process.env.GH_CONFIG_DIR), () =>
    join(
      Option.getOrElse(Option.fromUndefinedOr(process.env.XDG_CONFIG_HOME), () =>
        join(homedir(), ".config"),
      ),
      "gh",
    ),
  );

// A short id of its own, for the scenario's scratch base and its issue's title.
export const scratchId = () => randomUUID().slice(0, 8);

export type LiveLogin = { readonly login: string; readonly token: string };

// Sets the machine up for `slug`: clones it with the first login's token,
// and tells the fake agents each login's token by its hash, so a call can
// say whose it was without the token being written anywhere.
export const openLiveMachine = (slug: string, logins: ReadonlyArray<LiveLogin>) => {
  const root = mkdtempSync(join(tmpdir(), "chernabog-live-"));
  const home = join(root, "home");
  const checkout = join(root, "demo");
  const bin = join(root, "bin");
  const eventLog = join(root, "events.log");
  const disputing = join(root, "disputing");

  for (const dir of [home, bin, join(root, "claude"), join(root, "codex")]) {
    mkdirSync(dir, { recursive: true });
  }

  for (const fake of FAKES) {
    symlinkSync(join(ROOT, "test/fakebin", fake), join(bin, fake));
  }

  // The work account's login, which nothing but the fake claude reads.
  writeFileSync(
    join(root, "claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "fake-token", expiresAt: 4102444800000 } }),
  );

  writeFileSync(
    join(root, "personas"),
    logins
      .map(({ login, token }) => `${createHash("sha256").update(token).digest("hex")} ${login}\n`)
      .join(""),
  );

  writeFileSync(disputing, "");

  const inherited = Object.fromEntries(
    Object.entries(process.env).flatMap(([name, value]) =>
      Option.toArray(
        Option.map(
          Option.filter(Option.fromUndefinedOr(value), () => !UNSET.includes(name)),
          (found) => [name, found] as const,
        ),
      ),
    ),
  );

  const env = {
    ...inherited,
    GH_CONFIG_DIR: ghConfigDir(),
    // git's global and system config, never the person's.
    ...gitConfigIn(root),
    CHERNABOG_HOME: home,
    PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    FAKE_AGENT_SESSION_LOG: eventLog,
    FAKE_AGENT_PERSONAS: join(root, "personas"),
    FAKE_CLAUDE_LOG: join(root, "claude.log"),
    FAKE_CLAUDE_DISPUTING: disputing,
    FAKE_CODEX_LOG: join(root, "codex.log"),
    FAKE_CODEX_COMMENT_ON_CHANGE: "1",
    FAKE_TMUX_STATE: join(root, "tmux"),
    FAKE_TMUX_LOG: join(root, "tmux.log"),
  };

  // The first login's token clones it, as the writer's would.
  const cloneToken = Option.getOrElse(
    Option.map(Option.fromUndefinedOr(logins.at(0)), (first) => first.token),
    () => "",
  );

  execFileSync("git", ["clone", "-q", `https://github.com/${slug}.git`, checkout], {
    env: { ...env, ...gitCredentialEnv, GH_TOKEN: cloneToken },
    stdio: "pipe",
  });

  const cli = (args: ReadonlyArray<string>) =>
    Option.match(Option.fromUndefinedOr(process.env.CHERNABOG_BIN), {
      onNone: () =>
        spawn(process.execPath, [join(ROOT, "src/interface/cli/main.ts"), ...args], {
          env,
          cwd: checkout,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      onSome: (binary) =>
        spawn(binary, [...args], {
          env,
          cwd: checkout,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        }),
    });

  const runCli = (args: ReadonlyArray<string>) =>
    new Promise<CliResult>((resolve) => {
      const child = cli(args);
      let output = "";

      const collect = (chunk: Buffer) => {
        output += chunk.toString();
      };

      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("close", (code) => {
        resolve({ code: code ?? -1, output, pid: child.pid ?? -1 });
      });
    });

  const socket = join(home, "daemon.sock");
  let daemon = Option.none<ChildProcess>();

  // Starts the daemon, resolving once it listens.
  const startDaemon = async () => {
    daemon = Option.some(cli(["daemon"]));
    await waitFor(() => existsSync(socket), "the daemon", 60_000);
  };

  // Stops the daemon this machine started, only it, by the process it spawned.
  const stopDaemon = async () => {
    for (const child of Option.toArray(daemon)) {
      if (Option.isNone(Option.fromNullishOr(child.exitCode))) {
        const exited = closed(child);
        child.kill("SIGTERM");
        await exited;
      }
    }
  };

  const daemonStatus = async () =>
    Schema.decodeUnknownSync(DaemonStatus)(
      await (await fetch("http://daemon/status", { unix: socket })).json(),
    );

  const daemonLog = () => {
    const log = join(home, "daemon.log");

    if (!existsSync(log)) {
      return "the daemon wrote no log";
    }

    return `the daemon's log (${log}) ends:\n${readFileSync(log, "utf8").split("\n").slice(-40).join("\n")}`;
  };

  // Each fake agent call's line, after "session ", as it logged them.
  const sessionLines = () => {
    if (!existsSync(eventLog)) {
      return [];
    }

    return readFileSync(eventLog, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("session "))
      .map((line) => line.slice("session ".length));
  };

  // `login`'s agent declines what a review asks for from now on.
  const disagreeAs = (login: string) => {
    writeFileSync(disputing, `${login}\n`, { flag: "a" });
  };

  const writeMachineConfig = (text: string) => {
    writeFileSync(join(home, "config.yaml"), text);
  };

  return {
    root,
    home,
    checkout,
    runCli,
    startDaemon,
    stopDaemon,
    daemonStatus,
    daemonLog,
    sessionLines,
    disagreeAs,
    writeMachineConfig,
  };
};

export type LiveMachine = ReturnType<typeof openLiveMachine>;
