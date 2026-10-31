// A state-changing command goes through the daemon first, so what it says
// reaches the daemon's bus (docs/adr/0016-state-changing-commands-go-through-the-daemon.md):
// `chernabog pause` with the daemon running dispatches RepoPaused there, a
// refusal from it is the answer, and with no daemon the CLI pauses here.
// Which bus heard an event is read off the telemetry each process writes.

import { type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { closed, openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

const TelemetryLine = Schema.Struct({
  type: Schema.Literals(["span", "log"]),
  name: Schema.optional(Schema.String),
});

const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(TelemetryLine));

// The span names the files matching `file` wrote, across the day folders.
const spansIn = (home: string, file: (name: string) => boolean) => {
  const dir = join(home, "telemetry");

  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir)
    .flatMap((day) =>
      readdirSync(join(dir, day))
        .filter(file)
        .map((name) => join(dir, day, name)),
    )
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => decodeLine(line)),
    )
    .filter((record) => record.type === "span")
    .flatMap((record) => Option.toArray(Option.fromUndefinedOr(record.name)));
};

const daemonSpans = (sandbox: Sandbox) =>
  spansIn(sandbox.home, (name) => name.startsWith("daemon-"));

const cliSpans = (sandbox: Sandbox, pid: number) =>
  spansIn(sandbox.home, (name) => name === `cli-${pid}.jsonl`);

describe("a state-changing command", () => {
  let sandbox: Sandbox;
  // None until beforeAll starts it, so a beforeAll cut short stops nothing.
  let daemon: Option.Option<ChildProcess> = Option.none();

  const stopDaemon = async () => {
    for (const running of Option.toArray(daemon)) {
      if (Option.isNone(Option.fromNullishOr(running.exitCode))) {
        running.kill("SIGTERM");
        await closed(running);
      }
    }
  };

  beforeAll(async () => {
    sandbox = openSandbox();
    await sandbox.runCli(["trust", "demo"]);
    daemon = Option.some(sandbox.cli(["daemon"]));
    await waitFor(() => existsSync(join(sandbox.home, "daemon.sock")), "the daemon");
  }, 60_000);

  afterAll(async () => {
    await stopDaemon();
    await sandbox.github.stop();
  }, 30_000);

  test("with the daemon running, pause dispatches RepoPaused on the daemon's bus", async () => {
    const paused = await sandbox.runCli(["pause", "demo"]);

    expect(paused.code).toBe(0);
    expect(paused.output).toContain("paused demo");
    await waitFor(
      () => daemonSpans(sandbox).includes("event.RepoPaused"),
      "RepoPaused on the daemon's bus",
      10_000,
    );
    // The CLI dispatched nothing itself.
    expect(cliSpans(sandbox, paused.pid)).not.toContain("command.PauseRepoCommand");
    expect(cliSpans(sandbox, paused.pid)).not.toContain("event.RepoPaused");

    const resumed = await sandbox.runCli(["resume", "demo"]);

    expect(resumed.output).toContain("resumed demo");
    await waitFor(
      () => daemonSpans(sandbox).includes("event.RepoResumed"),
      "RepoResumed on the daemon's bus",
      10_000,
    );
  }, 30_000);

  test("a refusal from the daemon is the answer, never retried here", async () => {
    const refused = await sandbox.runCli(["pause", "nope"]);

    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain("nope");
    expect(cliSpans(sandbox, refused.pid)).not.toContain("command.PauseRepoCommand");
  }, 30_000);

  test("with no daemon, pause pauses here", async () => {
    await stopDaemon();

    const paused = await sandbox.runCli(["pause", "demo"]);

    expect(paused.code).toBe(0);
    expect(paused.output).toContain("paused demo");
    expect(cliSpans(sandbox, paused.pid)).toContain("event.RepoPaused");
    expect(readFileSync(join(sandbox.home, "paused.json"), "utf8")).toContain("dataquail/demo");

    await sandbox.runCli(["resume", "demo"]);
  }, 30_000);
});
