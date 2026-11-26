// A hangup on a sandboxed session's terminal (its Orca tab or tmux pane
// closed) ends its container (ADR 24, "The container"): the runtime's CLI
// dies with the terminal, but a container outlives its client, so
// `chernabog __launch` removes the session's containers by label.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";
import * as Schema from "effect/Schema";

import { LaunchSpecJson } from "../../src/modules/runs/infrastructure/runtime/launchers/shim.ts";
import { closed, waitFor } from "./sandbox.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const running = (pid: number) => Bun.spawnSync(["kill", "-0", String(pid)]).exitCode === 0;

test.each(["docker", "podman"] as const)(
  "a hangup on the terminal removes the session's %s container",
  async (runtime) => {
    const dir = mkdtempSync(join(tmpdir(), "chernabog-hangup-"));
    const spec = join(dir, "spec.json");
    const log = join(dir, "runtime.log");
    const agentPid = join(dir, "agent.pid");

    writeFileSync(
      spec,
      Schema.encodeSync(LaunchSpecJson)({
        command: "/bin/sh",
        args: ["-c", `echo $$ > ${agentPid}; exec sleep 60`],
        cwd: dir,
        env: {},
        sandbox: runtime,
        container: {
          image: "chernabog-sandbox:test",
          mounts: [{ path: dir }],
          labels: { "chernabog.run": "run-1", "chernabog.session": "session-1" },
        },
      }),
    );

    // As a launcher runs it, in a process group of its own as a terminal's
    // is; the fake container outlives its client, as a real one does.
    const launch = spawn(
      process.execPath,
      [join(ROOT, "src/interface/cli/main.ts"), "__launch", spec],
      {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          CHERNABOG_HOME: join(dir, "home"),
          PATH: `${join(ROOT, "test/fakebin")}:${process.env.PATH ?? ""}`,
          FAKE_RUNTIME_LOG: log,
          FAKE_RUNTIME_STATE: join(dir, "runtime"),
          FAKE_RUNTIME_DETACH: "1",
        },
      },
    );

    await waitFor(() => existsSync(agentPid), "the container's agent to start");
    const agent = Number(readFileSync(agentPid, "utf8"));

    process.kill(-(launch.pid ?? 0), "SIGHUP");

    await closed(launch);
    expect(launch.exitCode).toBe(129);
    expect(readFileSync(log, "utf8")).toContain(`${runtime} rm -f `);
    await waitFor(() => !running(agent), "the container to be gone", 5_000);
  },
  30_000,
);
