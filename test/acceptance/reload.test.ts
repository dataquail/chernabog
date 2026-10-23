// When the daemon restarts on a repo's .chernabog/: once for a tree trusted
// since, never again for a trusted tree that fails to load.

import { type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { Reloaded } from "../../src/interface/daemon/daemon.protocol.ts";
import { openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// One daemon at a time in a sandbox: start it, ask it to reload, stop it.
const daemonIn = (sandbox: () => Sandbox) => {
  let daemon: Option.Option<ChildProcess> = Option.none();
  let exit: Promise<number> = Promise.resolve(0);
  const socket = () => join(sandbox().home, "daemon.sock");

  const start = async () => {
    const started = sandbox().cli(["daemon"]);
    daemon = Option.some(started);

    exit = new Promise((resolve) => {
      started.on("close", (code) => {
        resolve(code ?? -1);
      });
    });

    await waitFor(() => existsSync(socket()), "the daemon's socket");
  };

  // What chernabog trust, enroll and init ask the daemon: whether it restarts.
  const reload = async () =>
    Schema.decodeUnknownSync(Reloaded)(
      await (await fetch("http://daemon/reload", { method: "POST", unix: socket() })).json(),
    ).reloadPending;

  const stop = async () => {
    if (Option.exists(daemon, (running) => Option.isNone(Option.fromNullishOr(running.exitCode)))) {
      Option.getOrThrow(daemon).kill("SIGTERM");
    }

    await exit;
  };

  return { start, reload, stop, exited: () => exit };
};

// A new .chernabog/ on the base branch, with this file changed.
const pushConfig = (sandbox: Sandbox, file: string, content: string) => {
  writeFileSync(join(sandbox.checkout, ".chernabog", file), content);
  sandbox.git(sandbox.checkout, "add", ".");
  sandbox.git(sandbox.checkout, "commit", "-qm", `chore: change ${file}`);
  sandbox.git(sandbox.checkout, "push", "-q", "origin", "main");
};

describe("restarting on a trusted .chernabog/ whose flows fail to load", () => {
  let sandbox: Sandbox;
  const daemon = daemonIn(() => sandbox);

  beforeAll(() => {
    sandbox = openSandbox({}, { repoFiles: { "flows/broken.ts": "export const notAFlow = 1;\n" } });
  });

  afterAll(async () => {
    await daemon.stop();
    await sandbox.github.stop();
  });

  test("a repo trusted since the daemon started restarts it once", async () => {
    await daemon.start();
    expect((await sandbox.runCli(["status"])).output).toContain("demo (dataquail/demo): untrusted");
    await sandbox.runCli(["trust", "demo"]);
    expect(await daemon.exited()).toBe(75);
  }, 30_000);

  test("restarts nothing on later checks", async () => {
    await daemon.start();
    expect((await sandbox.runCli(["status"])).output).toContain("demo (dataquail/demo): error");
    expect(await daemon.reload()).toBe(false);
    expect(await daemon.reload()).toBe(false);
  }, 30_000);

  test("a new trusted tree restarts it once", async () => {
    pushConfig(sandbox, "flows/broken.ts", "export const stillNotAFlow = 1;\n");
    await sandbox.runCli(["trust", "demo"]);
    expect(await daemon.exited()).toBe(75);
    await daemon.start();
    expect((await sandbox.runCli(["status"])).output).toContain("demo (dataquail/demo): error");
    expect(await daemon.reload()).toBe(false);
  }, 30_000);
});

describe("restarting on a .chernabog/ trusted after the daemon saw it change", () => {
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

  test("a ready repo restarts once its changed .chernabog/ is trusted", async () => {
    await daemon.start();
    expect((await sandbox.runCli(["status"])).output).toContain("demo (dataquail/demo): ready");
    pushConfig(sandbox, "notes.md", "# notes\n");
    expect(await daemon.reload()).toBe(false);
    expect((await sandbox.runCli(["status"])).output).toContain("demo (dataquail/demo): untrusted");
    await sandbox.runCli(["trust", "demo"]);
    expect(await daemon.exited()).toBe(75);
  }, 30_000);
});
