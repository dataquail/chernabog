// The implement flow on each agent, end to end, with fake CLIs that print the real event shapes.

import { existsSync, writeFileSync } from "node:fs";
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

afterAll(async () => {
  await Promise.all(sandboxes.map((sandbox) => sandbox.github.stop()));
});

describe("implement on Codex", () => {
  test("a repo whose account is a Codex account runs implement on Codex", async () => {
    const sandbox = sandboxFor({}, { account: "codex" });
    sandbox.github.addIssue("Do it with Codex", ["auto:eligible"]);
    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
    expect(output).toContain("codex: starting a thread");
    expect(output).toContain('$ bash -lc "git commit"');
    expect(output).toContain("done: #1:");
    expect(code).toBe(0);
    expect(Option.getOrThrow(sandbox.github.firstPull()).title).toBe(
      "feat: do the thing with codex",
    );
    expect(sandbox.claudeCalls()).toHaveLength(0);
    const [call] = sandbox.codexCalls();
    expect(call).toContain("--approve-for-me");
    expect(call).toContain('sandbox_mode=\\"workspace-write\\"');
    expect(call).toContain("--output-schema");
  }, 60_000);

  test("a run killed mid-agent resumes the same Codex thread", async () => {
    const sandbox = sandboxFor({}, { account: "codex" });
    sandbox.github.addIssue("Survive a crash on Codex", ["auto:eligible"]);
    const hang = join(sandbox.root, "hang-once");
    writeFileSync(hang, "");

    const first = sandbox.cli(["run", "implement", "--repo", "demo"], {
      FAKE_AGENT_HANG_ONCE: hang,
    });

    await waitFor(() => sandbox.codexCalls().length === 1 && !existsSync(hang), "codex to start");
    await Bun.sleep(300);
    process.kill(-(first.pid ?? 0), "SIGKILL");
    await closed(first);
    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
    expect(output).toContain("resuming");
    expect(code).toBe(0);
    const [start = "", resume = ""] = sandbox.codexCalls();
    expect(start).toStartWith("start ");
    expect(resume).toStartWith("resume ");
    expect(resume.split(" ")[1]).toBe(start.split(" ")[1]);
  }, 90_000);
});

describe("implement on opencode", () => {
  test("the answer format goes into the prompt, and the answer comes from the last message", async () => {
    const sandbox = sandboxFor({ agent: "opencode" });
    sandbox.github.addIssue("Do it with opencode", ["auto:eligible"]);
    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
    expect(output).toContain("done: #1:");
    expect(code).toBe(0);
    expect(sandbox.opencodeCalls()[0]).toEndWith("with-format");
    expect(Option.getOrThrow(sandbox.github.firstPull()).title).toBe("feat: opencode");
  }, 60_000);
});

describe("a custom agent from machine config", () => {
  test("runs its command template and reads the last JSON it prints", async () => {
    const script = `cd "$1" && n=$(git rev-list --count HEAD) && echo x > change-$n.txt && git add . && git -c user.name=F -c user.email=f@x commit -qm "feat: custom" && echo '{"status":"done","summary":"s","title":"feat: custom","body":"b"}'`;

    const sandbox = sandboxFor(
      { agent: "mine" },
      { agents: { mine: { start: ["sh", "-c", script, "sh", "{cwd}"] } } },
    );

    sandbox.github.addIssue("Do it my way", ["auto:eligible"]);
    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
    expect(output).toContain("done: #1:");
    expect(code).toBe(0);
  }, 60_000);
});
