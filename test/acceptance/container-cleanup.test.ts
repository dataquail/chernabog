// A sandboxed repo's containers, which carry their run's id as a label (ADR
// 24, decision 9), through the real CLI and daemon with the fake runtime:
// cancel removes a running session's container before it says the run is
// cancelled, and the daemon's sweep removes one a killed shim left behind
// for a run that has ended. Neither ever names a container.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";

import { LaunchSpecJson } from "../../src/modules/runs/infrastructure/runtime/launchers/shim.ts";
import { closed, openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// A flow that finds nothing, so nothing but the runs a test makes is in play.
const IDLE = `import { defineFlow } from "@chernabog/sdk";
import * as Effect from "effect/Effect";

export default defineFlow({
  trigger: Effect.succeed([]),
  workflow: () => Effect.succeed("nothing"),
});
`;

const running = (pid: number) => Bun.spawnSync(["kill", "-0", String(pid)]).exitCode === 0;

describe("a sandboxed repo's containers", () => {
  let sandbox: Sandbox;
  const launches: Array<ChildProcess> = [];
  const agents: Array<number> = [];

  // The fake runtime's log and its containers, and, as a real container
  // outlives its client, containers that outlive the CLI that ran them.
  const runtimeEnv = () => ({
    FAKE_RUNTIME_LOG: join(sandbox.root, "runtime.log"),
    FAKE_RUNTIME_STATE: join(sandbox.root, "runtime"),
    FAKE_RUNTIME_DETACH: "1",
  });

  const runtimeLog = () => {
    const log = join(sandbox.root, "runtime.log");

    if (!existsSync(log)) {
      return "";
    }

    return readFileSync(log, "utf8");
  };

  // How many containers the fake runtime keeps; none before it has run one.
  const containers = () => {
    const state = join(sandbox.root, "runtime");

    if (!existsSync(state)) {
      return 0;
    }

    return readdirSync(state).filter((name) => name.endsWith(".json")).length;
  };

  // A session's `chernabog __launch` running its agent in a docker container
  // labelled with `runId`, as a launcher runs it, in a process group of its
  // own: once the agent is up in it, the launch and the agent's PID.
  const launchSession = async (runId: string, sessionId: string) => {
    const dir = join(sandbox.home, "sessions/interactive", sessionId);
    const agentPid = join(dir, "container-agent.pid");
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      join(dir, "spec.json"),
      Schema.encodeSync(LaunchSpecJson)({
        command: "/bin/sh",
        args: ["-c", `echo $$ > ${agentPid}; exec sleep 120`],
        cwd: sandbox.checkout,
        env: {},
        pidFile: join(dir, "agent.pid"),
        sandbox: "docker",
        container: {
          image: "chernabog-sandbox:test",
          mounts: [{ path: sandbox.checkout }],
          labels: { "chernabog.run": runId, "chernabog.session": sessionId },
        },
      }),
    );

    const before = containers();

    const launch = spawn(
      process.execPath,
      [join(ROOT, "src/interface/cli/main.ts"), "__launch", join(dir, "spec.json")],
      {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          CHERNABOG_HOME: sandbox.home,
          PATH: `${join(ROOT, "test/fakebin")}:${process.env.PATH ?? ""}`,
          ...runtimeEnv(),
        },
      },
    );

    launches.push(launch);

    await waitFor(
      () =>
        existsSync(agentPid) && existsSync(join(sandbox.root, "runtime")) && containers() > before,
      "the container's agent to start",
    );

    const agent = Number(readFileSync(agentPid, "utf8"));
    agents.push(agent);

    return { launch, agent };
  };

  beforeAll(async () => {
    sandbox = openSandbox(
      { sandbox: "docker" },
      { flows: { idle: {} }, recipes: [], repoFiles: { "flows/idle.ts": IDLE } },
    );
    await sandbox.runCli(["trust", "demo"]);
  });

  // Whatever a failed test left running: the launches' process groups and the
  // agents in their detached containers.
  afterAll(async () => {
    for (const target of [
      ...launches.map((launch) => `-${launch.pid ?? 0}`),
      ...agents.map(String),
    ]) {
      Bun.spawnSync(["kill", "-KILL", "--", target]);
    }

    await sandbox.github.stop();
  });

  test("cancel removes a running session's container before it says the run is cancelled", async () => {
    const { runId } = sandbox.recordRun("idle", { key: "issue-1", data: {} });
    const { agent } = await launchSession(runId, "session-cancelled");

    const { code, output } = await sandbox.runCli(["cancel", runId], runtimeEnv());

    expect(code).toBe(0);
    expect(output).toContain(`cancelled ${runId}`);
    expect(output).toMatch(/removed docker container \S+/);
    // Asked by the run's label, never by a container's name, and removed by
    // the time cancel answered.
    expect(runtimeLog()).toContain("docker rm -f ");
    await waitFor(() => !running(agent), "the container to be gone", 5_000);
  }, 90_000);

  test("the daemon's sweep removes the container a killed shim left behind for a run that ended", async () => {
    const { agent, launch } = await launchSession("run-that-ended", "session-orphaned");

    // The shim dies without its cleanup, and its runtime's CLI with it: the
    // container goes on running, as one does in the runtime's daemon or VM.
    const shimDied = closed(launch);
    process.kill(-(launch.pid ?? 0), "SIGKILL");
    await shimDied;
    expect(running(agent)).toBe(true);

    const daemon = sandbox.cli(["daemon"], runtimeEnv());
    await sandbox.daemonReady();

    // Stopped whether or not the sweep came, so a failure leaves no daemon.
    const swept = await waitFor(() => !running(agent), "the sweep to remove the container").then(
      () => "removed",
      () => "still running",
    );

    await sandbox.stopDaemon(daemon);

    expect(swept).toBe("removed");
    expect(sandbox.daemonLog()).toMatch(
      /removed docker container \S+ of run-that-ended, which had ended/,
    );
  }, 90_000);
});
