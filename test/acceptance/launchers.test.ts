// Claude as an interactive session under each launcher, end to end: the answer
// file and the Stop hook decide when it is done, and nothing runs `claude -p`.

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { closed, openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

const sandboxes: Array<Sandbox> = [];

const sandboxFor = (...args: Parameters<typeof openSandbox>) => {
  const sandbox = openSandbox(...args);
  sandboxes.push(sandbox);

  return sandbox;
};

// A failed test can leave a fake session idling; end them all.
const endSessions = (sandbox: Sandbox) => {
  for (const dir of ["tmux", "orca"]) {
    if (!existsSync(join(sandbox.root, dir))) {
      continue;
    }

    // kill(1) rather than process.kill, which throws for a session already ended.
    for (const pidFile of new Bun.Glob("*.pid").scanSync(join(sandbox.root, dir))) {
      Bun.spawnSync(["kill", "-9", `-${readFileSync(join(sandbox.root, dir, pidFile), "utf8")}`]);
    }
  }
};

afterAll(async () => {
  sandboxes.forEach(endSessions);
  await Promise.all(sandboxes.map((sandbox) => sandbox.github.stop()));
});

const headlessCalls = (sandbox: Sandbox) =>
  sandbox.claudeCalls().filter((call) => call.split(" ")[2] === "-p");

// Ends the fake tmux session, as closing its terminal would.
const killTmuxSession = (sandbox: Sandbox) => {
  const [pidFile = ""] = [...new Bun.Glob("*.pid").scanSync(join(sandbox.root, "tmux"))];
  process.kill(-Number(readFileSync(join(sandbox.root, "tmux", pidFile), "utf8")), "SIGKILL");
};

const launchRecorded = (sandbox: Sandbox) =>
  [...new Bun.Glob("*/launch.json").scanSync(join(sandbox.home, "sessions/interactive"))].length >
  0;

const CUSTOM = {
  start: ["tmux", "new-session", "-d", "-s", "{title}", "-c", "{cwd}", "sh", "-c", "{command}"],
  close: ["tmux", "kill-session", "-t", "{handle}"],
  alive: ["tmux", "has-session", "-t", "{handle}"],
};

describe.each(["tmux", "orca", "mine", "headless"])(
  "implement with the %s launcher",
  (launcher) => {
    test("takes a queued issue to a green pull request handed off for review", async () => {
      const sandbox = sandboxFor({}, { launcher, launchers: { mine: CUSTOM } });
      sandbox.github.addIssue("Do the thing", ["auto:eligible"]);
      const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
      expect(output).toContain("done: #1:");
      expect(code).toBe(0);
      expect(Option.getOrThrow(sandbox.github.firstPull()).labels).toContain("auto:needs-review");
      expect(sandbox.claudeCalls()).toHaveLength(1);

      if (launcher === "headless") {
        expect(headlessCalls(sandbox)).toHaveLength(1);

        return;
      }

      expect(headlessCalls(sandbox)).toHaveLength(0);
      expect(sandbox.hookCalls().map((call) => call.split(" ")[2])).toEqual(["allow"]);

      // The session is closed once it has answered.
      const closes = [
        ...sandbox.tmuxCalls().filter((call) => call.startsWith("kill-session")),
        ...sandbox.orcaCalls().filter((call) => call === "terminal close"),
      ];

      expect(closes).toHaveLength(1);

      // The spec holds the session's environment, so only its owner reads it.
      const specs = [
        ...new Bun.Glob("*/spec.json").scanSync(join(sandbox.home, "sessions/interactive")),
      ];

      expect(
        specs.map(
          (spec) => statSync(join(sandbox.home, "sessions/interactive", spec)).mode & 0o777,
        ),
      ).toEqual([0o600]);
    }, 60_000);
  },
);

describe("the answer file", () => {
  test("a session that stops without its answer is sent back to write it", async () => {
    const sandbox = sandboxFor({}, { launcher: "tmux" });
    sandbox.github.addIssue("Forget the answer once", ["auto:eligible"]);
    const skip = join(sandbox.root, "skip-once");
    writeFileSync(skip, "");

    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"], {
      FAKE_CLAUDE_SKIP_ANSWER_ONCE: skip,
    });

    expect(output).toContain("done: #1:");
    expect(code).toBe(0);
    expect(sandbox.hookCalls().map((call) => call.split(" ")[2])).toEqual(["block", "allow"]);
  }, 60_000);

  test("no valid answer after three reminders hands the issue to a person", async () => {
    const sandbox = sandboxFor({}, { launcher: "tmux" });
    const issue = sandbox.github.addIssue("Never answer", ["auto:eligible"]);

    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"], {
      FAKE_CLAUDE_NEVER_ANSWER: "1",
    });

    expect(output).toContain(
      "needs-human: #1 needs a person: implement: claude: no valid answer after 3 reminders",
    );
    expect(code).toBe(0);
    expect(sandbox.github.issue(issue).labels).toContain("auto:needs-human");
    expect(sandbox.github.issue(issue).labels).not.toContain("auto:in-progress");
    expect(sandbox.hookCalls().map((call) => call.split(" ")[2])).toEqual([
      "block",
      "block",
      "block",
      "allow",
    ]);
    expect(sandbox.github.pulls.size).toBe(0);
  }, 60_000);
});

describe("doctor", () => {
  test("shows where the launcher came from, and reports a missing tmux and an unreachable Orca", async () => {
    const tmux = sandboxFor({}, { launcher: "tmux" });
    const missing = await tmux.runCli(["doctor"], { FAKE_TMUX_MISSING: "1" });
    expect(missing.output).toContain("✓ demo: launcher tmux (machine config)");
    expect(missing.output).toContain("✗ tmux: not found");
    expect(missing.output).toContain(`✗ demo: Claude trusts ${tmux.checkout}`);

    const orca = sandboxFor({}, { launcher: "orca" });
    const down = await orca.runCli(["doctor"], { FAKE_ORCA_DOWN: "1" });
    expect(down.output).toContain("✗ orca: running and reachable");

    const headless = sandboxFor();
    expect((await headless.runCli(["doctor"])).output).toContain(
      "✓ demo: runs use claude -p (launcher headless)",
    );
  }, 60_000);
});

describe("an interactive session outliving its run", () => {
  test("a rerun after the CLI is killed waits on the running session instead of starting another", async () => {
    const sandbox = sandboxFor({}, { launcher: "tmux" });
    sandbox.github.addIssue("Outlive the CLI", ["auto:eligible"]);
    const hold = join(sandbox.root, "hold");
    writeFileSync(hold, "");
    const extra = { FAKE_CLAUDE_HOLD: hold };
    const first = sandbox.cli(["run", "implement", "--repo", "demo"], extra);
    await waitFor(
      () => sandbox.claudeCalls().length === 1 && launchRecorded(sandbox),
      "the session to start",
    );
    process.kill(-(first.pid ?? 0), "SIGKILL");
    await closed(first);

    const rerun = sandbox.runCli(["run", "implement", "--repo", "demo"], extra);
    await Bun.sleep(3000);
    rmSync(hold);
    const { code, output } = await rerun;
    expect(output).toContain("is still running in tmux; waiting on it");
    expect(output).toContain("done: #1:");
    expect(code).toBe(0);
    expect(sandbox.claudeCalls()).toHaveLength(1);
    expect(sandbox.tmuxCalls().filter((call) => call.startsWith("new-session"))).toHaveLength(1);
  }, 90_000);

  test("a session the launcher wrongly says ended is waited on, not resumed into a second agent", async () => {
    const sandbox = sandboxFor({}, { launcher: "orca" });
    sandbox.github.addIssue("Outlive what Orca says", ["auto:eligible"]);
    const hold = join(sandbox.root, "hold");
    writeFileSync(hold, "");

    const run = sandbox.runCli(["run", "implement", "--repo", "demo"], {
      FAKE_CLAUDE_HOLD: hold,
      FAKE_ORCA_SAYS_ENDED: "1",
    });

    await waitFor(
      () => sandbox.claudeCalls().length === 1 && launchRecorded(sandbox),
      "the session to start",
    );
    await Bun.sleep(3000);
    rmSync(hold);
    const { code, output } = await run;
    expect(output).toContain(
      "orca says the session ended, but its process still runs; waiting on it",
    );
    expect(output).toContain("done: #1:");
    expect(code).toBe(0);
    expect(sandbox.claudeCalls()).toHaveLength(1);
    expect(sandbox.orcaCalls().filter((call) => call === "terminal create")).toHaveLength(1);
  }, 90_000);

  test("a session that dies before answering is resumed", async () => {
    const sandbox = sandboxFor({}, { launcher: "tmux" });
    sandbox.github.addIssue("Lose the session", ["auto:eligible"]);
    const hold = join(sandbox.root, "hold");
    writeFileSync(hold, "");
    const run = sandbox.runCli(["run", "implement", "--repo", "demo"], { FAKE_CLAUDE_HOLD: hold });
    await waitFor(
      () => sandbox.claudeCalls().length === 1 && existsSync(join(sandbox.root, "tmux")),
      "the session to start",
    );
    await Bun.sleep(500);
    killTmuxSession(sandbox);
    rmSync(hold);
    const { code, output } = await run;
    expect(output).toContain("resuming session");
    expect(output).toContain("done: #1:");
    expect(code).toBe(0);
    const [start = "", resume = ""] = sandbox.claudeCalls();
    expect(start).toStartWith("start ");
    expect(resume).toStartWith("resume ");
    expect(resume.split(" ")[1]).toBe(start.split(" ")[1]);
  }, 90_000);
});
