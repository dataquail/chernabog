// Version compatibility, end to end: a repo whose flows this binary can't run
// is refused and shown as incompatible; a run in flight from an SDK it doesn't
// run goes to a person at startup; and a daemon whose binary changes drains
// and restarts on it.

import { type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { supportedRange } from "../../src/kernel/sdk-support.value-object.ts";
import { openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// One daemon at a time in a sandbox, with `env` added: start it, ask it to
// look for changes, stop it.
const daemonIn = (sandbox: () => Sandbox, env: Readonly<Record<string, string>> = {}) => {
  let daemon: Option.Option<ChildProcess> = Option.none();
  let exit: Promise<number> = Promise.resolve(0);
  const socket = () => join(sandbox().home, "daemon.sock");

  const start = async () => {
    const started = sandbox().cli(["daemon"], env);
    daemon = Option.some(started);

    exit = new Promise((resolve) => {
      started.on("close", (code) => {
        resolve(code ?? -1);
      });
    });

    await waitFor(() => existsSync(socket()), "the daemon's socket");
  };

  const reload = () => fetch("http://daemon/reload", { method: "POST", unix: socket() });

  const stop = async () => {
    if (Option.exists(daemon, (running) => Option.isNone(Option.fromNullishOr(running.exitCode)))) {
      Option.getOrThrow(daemon).kill("SIGTERM");
    }

    await exit;
  };

  return { start, reload, stop, exited: () => exit };
};

describe("a repo whose flows are written against an SDK this binary doesn't run", () => {
  let sandbox: Sandbox;
  const daemon = daemonIn(() => sandbox);

  beforeAll(async () => {
    sandbox = openSandbox(
      {},
      { repoFiles: { "package.json": '{ "devDependencies": { "@chernabog/sdk": "0.0.1" } }\n' } },
    );
    await sandbox.runCli(["trust", "demo"]);
  });

  afterAll(async () => {
    await daemon.stop();
    await sandbox.github.stop();
  });

  test("is incompatible in status and doctor, naming the upgrade", async () => {
    await daemon.start();
    const status = (await sandbox.runCli(["status"])).output;

    expect(status).toContain("demo (dataquail/demo): incompatible");
    expect(status).toContain(`its flows are written against @chernabog/sdk 0.0.1, and chernabog`);
    expect(status).toContain(
      `runs ${supportedRange}; move the flows with chernabog recipes upgrade`,
    );
    expect((await sandbox.runCli(["doctor"])).output).toContain("demo: incompatible:");
  }, 60_000);
});

describe("a run in flight from an SDK this binary doesn't run", () => {
  let sandbox: Sandbox;
  const daemon = daemonIn(() => sandbox);

  beforeAll(async () => {
    sandbox = openSandbox();
    await sandbox.runCli(["trust", "demo"]);
  });

  afterAll(async () => {
    await daemon.stop();
    await sandbox.github.stop();
  });

  test("goes to a person at startup, rather than resume", async () => {
    // Once, so state.db has its tables, then as a run an older binary left.
    await daemon.start();
    await daemon.stop();
    const db = new Database(join(sandbox.home, "state.db"));
    db.run(
      `INSERT INTO om_runs (id, repo, flow, item_key, status, sdk_version, started_at)
       VALUES ('old-run', 'demo', 'review', 'pr-41', 'running', '0.0.1', '2026-10-01T00:00:00.000Z')`,
    );
    db.close();

    await daemon.start();
    await waitFor(() => sandbox.daemonLog().includes("ended old-run"), "the old run to end");

    const reopened = new Database(join(sandbox.home, "state.db"), { readonly: true });

    const row = reopened
      .query<{ status: string; summary: string }, []>(
        "SELECT status, summary FROM om_runs WHERE id = 'old-run'",
      )
      .get();

    reopened.close();
    expect(row).toEqual({
      status: "needs-human",
      summary: `it started under @chernabog/sdk 0.0.1, and this chernabog runs @chernabog/sdk ${supportedRange}, so it wasn't resumed`,
    });
  }, 60_000);
});

describe("a daemon whose binary changes under it", () => {
  let sandbox: Sandbox;
  let binary: string;
  let watched: ReturnType<typeof daemonIn>;

  beforeAll(async () => {
    sandbox = openSandbox();
    binary = join(sandbox.root, "chernabog-binary");
    writeFileSync(binary, "v1");
    watched = daemonIn(() => sandbox, { CHERNABOG_EXECUTABLE: binary });
    await sandbox.runCli(["trust", "demo"]);
  });

  afterAll(async () => {
    await watched.stop();
    await sandbox.github.stop();
  });

  test("drains and restarts on it once nothing is executing", async () => {
    await watched.start();
    expect(sandbox.daemonLog()).not.toContain("draining");

    writeFileSync(binary, "v2, a new version");
    await watched.reload();

    expect(await watched.exited()).toBe(75);
    expect(sandbox.daemonLog()).toContain(`chernabog changed at ${binary}; draining`);
    expect(sandbox.daemonLog()).toContain("restarting on the new chernabog");
  }, 60_000);
});
