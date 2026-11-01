// POST /runs/:id/attach, the dashboard's "Open in launcher": the daemon opens
// the run's session in its launcher on its own machine, and refuses a run
// whose session has no launcher to open it in.

import { type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HEADLESS } from "@chernabog/core";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { AttachOpened, Refusal } from "../../src/interface/daemon/daemon.protocol.ts";
import { LaunchRecord } from "../../src/modules/runs/infrastructure/runtime/agents/session-files.ts";
import { SessionRecord } from "../../src/modules/runs/infrastructure/runtime/agents/sessions.ts";
import { openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

const TMUX_RUN = "5714245a-211c-4f0d-8ce1-74b725bac0d6";
const HEADLESS_RUN = "0000aaaa-211c-4f0d-8ce1-74b725bac0d6";

const decodeAnswer = Schema.decodeUnknownSync(Schema.Union([AttachOpened, Refusal]));

const encodeSession = Schema.encodeSync(Schema.fromJsonString(SessionRecord));
const encodeLaunch = Schema.encodeSync(LaunchRecord);

describe("the daemon's attach route", () => {
  let sandbox: Sandbox;
  let daemon: Option.Option<ChildProcess> = Option.none();
  let exit: Promise<number> = Promise.resolve(0);
  const socket = () => join(sandbox.home, "daemon.sock");

  // A run with one session, under tmux with `handle`, or headless.
  const sessionFor = (runId: string, sessionId: string, handle: Option.Option<string>) => {
    mkdirSync(join(sandbox.home, "sessions/runs"), { recursive: true });
    writeFileSync(
      join(sandbox.home, "sessions/runs", `${runId}.jsonl`),
      `${encodeSession({
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
        at: "2026-10-31T12:00:00.000Z",
      })}\n`,
    );

    for (const name of Option.toArray(handle)) {
      const dir = join(sandbox.home, "sessions/interactive", sessionId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "launch.json"),
        encodeLaunch({
          launcher: { ...HEADLESS, name: "tmux", from: "machine config" },
          handle: name,
          at: "2026-10-31T12:00:00.000Z",
        }),
      );
      // The fake tmux's session runs while its pid does: this test's.
      mkdirSync(join(sandbox.root, "tmux"), { recursive: true });
      writeFileSync(join(sandbox.root, "tmux", `${name}.pid`), String(process.pid));
    }
  };

  const attach = async (runId: string) => {
    const response = await fetch(`http://chernabog/runs/${runId}/attach`, {
      method: "POST",
      unix: socket(),
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    return { status: response.status, body: decodeAnswer(await response.json()) };
  };

  beforeAll(async () => {
    sandbox = openSandbox();
    sessionFor(TMUX_RUN, "abc", Option.some("chernabog-abc"));
    sessionFor(HEADLESS_RUN, "def", Option.none());

    const started = sandbox.cli(["daemon"]);
    daemon = Option.some(started);

    exit = new Promise((resolve) => {
      started.on("close", (code) => {
        resolve(code ?? -1);
      });
    });

    await waitFor(() => existsSync(socket()), "the daemon's socket");
  });

  afterAll(async () => {
    if ("DEBUG_DAEMON" in process.env) {
      process.stdout.write(`${sandbox.daemonLog()}\n`);
    }

    for (const running of Option.toArray(daemon)) {
      running.kill("SIGTERM");
    }

    await exit;
    await sandbox.github.stop();
  });

  test("opens the session of a run under tmux, in tmux, on the daemon's machine", async () => {
    expect(await attach(TMUX_RUN)).toEqual({
      status: 200,
      body: { launcher: "tmux", sessionId: "abc" },
    });
    expect(sandbox.tmuxCalls()).toContain("switch-client -t =chernabog-abc");
  });

  test("refuses a run whose session runs headless, saying what to do instead", async () => {
    expect(await attach(HEADLESS_RUN)).toEqual({
      status: 409,
      body: {
        error:
          "its session runs headless, with no launcher to open it in: copy the attach command and run it in a terminal",
      },
    });
  });

  test("refuses a run that opened no session", async () => {
    const unknown = "11111111-2222-4333-8444-555555555555";

    expect(await attach(unknown)).toEqual({
      status: 409,
      body: { error: `${unknown} has opened no agent session yet` },
    });
  });
});
