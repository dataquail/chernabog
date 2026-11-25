// The agent sessions of a run that a stopped process left (#665), through the
// real CLI and daemon against the fake GitHub and the fake tmux. Whoever ends
// such a run as interrupted closes its agent's sessions: the run that owned
// them is dead, so nobody watches them, and the run that repeats its phase
// would work beside them. A session a person works in stays open. Both paths
// end such runs: the foreground `run`'s takeover of a run of its flow, and a
// hub's reap of the spokes of the hub before it.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { encodeSessionOpened } from "../../src/modules/runs/domain/run/agent-session-opened.value-object.ts";
import { LaunchRecord } from "../../src/modules/runs/infrastructure/runtime/agents/session-files.ts";
import { SessionRecord } from "../../src/modules/runs/infrastructure/runtime/agents/sessions.ts";
import { openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// A flow that finds nothing, so nothing but the left run is in play.
const IDLE = `import { defineFlow } from "@chernabog/sdk";
import * as Effect from "effect/Effect";

export default defineFlow({
  trigger: Effect.succeed([]),
  workflow: () => Effect.succeed("nothing"),
});
`;

const TMUX = { name: "tmux", from: "machine", custom: Option.none() };

const encodeLaunch = Schema.encodeSync(LaunchRecord);
const encodeSession = Schema.encodeSync(Schema.fromJsonString(SessionRecord));

const sessionsOf = (sandbox: Sandbox) => join(sandbox.home, "sessions");

const launchFile = (sandbox: Sandbox, sessionId: string) =>
  join(sessionsOf(sandbox), "interactive", sessionId, "launch.json");

// Whether a process is alive, by its PID: `kill -0` reaches it.
const alive = (pid: number) => spawnSync("kill", ["-0", String(pid)]).status === 0;

describe("the sessions of a run a stopped process left", () => {
  const started: Array<ChildProcess> = [];

  afterEach(() => {
    for (const child of started.splice(0)) {
      child.kill("SIGKILL");
    }
  });

  // A session under the fake tmux, as a launcher would have started it: a
  // detached process, named by `handle`. Its PID.
  const session = (sandbox: Sandbox, sessionId: string, withPerson: boolean) => {
    const handle = `chernabog-${sessionId}`;
    const child = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
    started.push(child);
    mkdirSync(join(sandbox.root, "tmux"), { recursive: true });
    writeFileSync(join(sandbox.root, "tmux", `${handle}.pid`), String(child.pid));
    mkdirSync(join(sessionsOf(sandbox), "interactive", sessionId), { recursive: true });
    writeFileSync(
      launchFile(sandbox, sessionId),
      encodeLaunch({ launcher: TMUX, handle, at: new Date().toISOString(), withPerson }),
    );

    return child.pid ?? 0;
  };

  // The run's own record of the sessions it opened, as a run in this process keeps it.
  const openedBy = (sandbox: Sandbox, runId: string, sessionIds: ReadonlyArray<string>) => {
    mkdirSync(join(sessionsOf(sandbox), "runs"), { recursive: true });
    writeFileSync(
      join(sessionsOf(sandbox), "runs", `${runId}.jsonl`),
      sessionIds
        .map((sessionId) =>
          encodeSession({
            adapter: "claude",
            sessionId,
            cwd: sandbox.checkout,
            account: {
              name: "default",
              configDir: Option.none(),
              expectedEmail: Option.none(),
              oauthTokenEnv: Option.none(),
              usageGate: "usage",
            },
            at: new Date().toISOString(),
          }),
        )
        .map((line) => `${line}\n`)
        .join(""),
    );
  };

  const sandboxFor = () =>
    openSandbox(
      {},
      { launcher: "tmux", flows: { idle: {} }, recipes: [], repoFiles: { "flows/idle.ts": IDLE } },
    );

  const statusOf = (sandbox: Sandbox, runId: string) => {
    const db = new Database(join(sandbox.home, "state.db"), { readonly: true });
    const row = db.query("SELECT status FROM om_runs WHERE id = ?").get(runId);
    db.close();

    return Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String }))(row).status;
  };

  test("the foreground run's takeover closes the left agent's session and leaves a person's open", async () => {
    const sandbox = sandboxFor();
    const { runId } = sandbox.recordRun("idle", { key: "issue-1", data: {} });
    const agent = session(sandbox, "agent-1", false);
    const person = session(sandbox, "person-1", true);
    openedBy(sandbox, runId, ["agent-1", "person-1"]);

    const { code, output } = await sandbox.runCli(["run", "idle", "--repo", "demo"]);

    expect(code).toBe(0);
    expect(output).toContain("as interrupted");
    expect(output).toContain("closed its tmux session chernabog-agent-1");
    expect(output).toContain("left tmux session chernabog-person-1 open: a person works in it");
    expect(statusOf(sandbox, runId)).toBe("interrupted");
    await waitFor(() => !alive(agent), "the agent's session to close");
    expect(alive(person)).toBe(true);
  }, 60_000);

  test("a hub's reap closes an orphaned agent's session and leaves a person's open", async () => {
    const sandbox = sandboxFor();
    await sandbox.runCli(["trust", "demo"]);
    const { runId } = sandbox.recordRun("idle", { key: "issue-1", data: {} });
    const agent = session(sandbox, "agent-2", false);
    const person = session(sandbox, "person-2", true);

    // The spoke the hub before recorded, gone now, and the sessions it
    // reported opening in its journal.
    const gone = spawn("true");
    await new Promise((resolve) => gone.on("close", resolve));

    const state = new Database(join(sandbox.home, "state.db"));
    state.run(
      "INSERT INTO om_spokes (run_id, pid, started_at, hub_pid, hub_started_at, folded_seq, ending) VALUES (?, ?, NULL, ?, NULL, 0, NULL)",
      [runId, gone.pid ?? 0, gone.pid ?? 0],
    );
    state.close();

    mkdirSync(join(sandbox.home, "journals"), { recursive: true });
    const journal = new Database(join(sandbox.home, "journals", `${runId}.db`), { create: true });
    journal.run(
      "CREATE TABLE spoke_reports (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, tag TEXT NOT NULL, payload TEXT NOT NULL)",
    );

    for (const sessionId of ["agent-2", "person-2"]) {
      journal.run("INSERT INTO spoke_reports (at, tag, payload) VALUES (?, ?, ?)", [
        new Date().toISOString(),
        "AgentSessionOpened",
        encodeSessionOpened({
          adapter: "claude",
          sessionId,
          launch: launchFile(sandbox, sessionId),
        }),
      ]);
    }

    journal.close();

    const daemon = sandbox.cli(["daemon"]);
    started.push(daemon);

    await waitFor(() => statusOf(sandbox, runId) === "interrupted", "the reap to end the run");
    await waitFor(() => !alive(agent), "the agent's session to close");
    expect(alive(person)).toBe(true);
    expect(sandbox.daemonLog()).toContain("closed its tmux session chernabog-agent-2");
    expect(sandbox.daemonLog()).toContain(
      "left tmux session chernabog-person-2 open: a person works in it",
    );
    expect(existsSync(join(sandbox.home, "journals", `${runId}.db`))).toBe(false);
    daemon.kill("SIGTERM");
    await new Promise((resolve) => daemon.on("close", resolve));
  }, 60_000);
});
