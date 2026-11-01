// The dashboard's listener for a browser: `chernabog ui` opens it on
// 127.0.0.1 and closes it, the daemon opens it again when it restarts, and
// every request on it passes the token, Host, Origin and Content-Type checks.

import { type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DaemonStatus } from "../../src/interface/daemon/daemon.protocol.ts";
import { openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// A port nothing listens on now.
const freePort = () => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const { port } = probe;
  void probe.stop(true);

  return port ?? 0;
};

// Holds a port, as another program would, until released.
const holdPort = (port: number) =>
  Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("someone else") });

// Whether anything answers on the port.
const answers = async (port: number) =>
  fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" }).then(
    () => true,
    () => false,
  );

// What dashboard.json records: whether the listener is to run, and where.
const DashboardRecord = Schema.fromJsonString(
  Schema.Struct({ running: Schema.Boolean, port: Schema.Int }),
);

// Runs `body` while another program holds the port.
const withPortHeld = async (port: number, body: () => Promise<void>) => {
  const other = holdPort(port);

  const failed = await body().then(
    () => Option.none<Error>(),
    (error: Error) => Option.some(error),
  );

  await other.stop(true);

  if (Option.isSome(failed)) {
    throw failed.value;
  }
};

const tokenIn = (url: string) => new URL(url).searchParams.get("token") ?? "";

const urlIn = (output: string) =>
  output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+/)?.[0] ?? "";

describe("the dashboard's listener", () => {
  let sandbox: Sandbox;
  let daemon: Option.Option<ChildProcess> = Option.none();
  let exit: Promise<number> = Promise.resolve(0);
  const socket = () => join(sandbox.home, "daemon.sock");

  const record = () =>
    Schema.decodeSync(DashboardRecord)(readFileSync(join(sandbox.home, "dashboard.json"), "utf8"));

  const tokenFile = () => join(sandbox.home, "dashboard.token");

  const startDaemon = async () => {
    const started = sandbox.cli(["daemon"]);
    daemon = Option.some(started);

    exit = new Promise((resolve) => {
      started.on("close", (code) => {
        resolve(code ?? -1);
      });
    });

    await waitFor(() => existsSync(socket()), "the daemon's socket");
  };

  const stopDaemon = async () => {
    if (Option.exists(daemon, (running) => Option.isNone(Option.fromNullishOr(running.exitCode)))) {
      Option.getOrThrow(daemon).kill("SIGTERM");
    }

    await exit;
    await waitFor(() => !existsSync(socket()), "the daemon's socket to go");
  };

  // The cookie the listener sets for the token, as a browser sends it back.
  const cookieFor = async (port: number, token: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/?token=${token}`, {
      redirect: "manual",
    });

    return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };

  const portA = freePort();
  const portB = freePort();

  beforeAll(async () => {
    sandbox = openSandbox();
    await startDaemon();
  });

  afterAll(async () => {
    if ("DEBUG_DAEMON" in process.env) {
      process.stdout.write(`${sandbox.daemonLog()}\n`);
    }

    await stopDaemon();
    await sandbox.github.stop();
  });

  test("opens no TCP port until asked", async () => {
    const { code, output } = await sandbox.runCli(["ui", "status"]);

    expect(code).toBe(0);
    expect(output).toContain("the dashboard is not running");
    expect(existsSync(join(sandbox.home, "dashboard.json"))).toBe(false);
    expect(await answers(4848)).toBe(false);
  });

  test("ui start opens it on 127.0.0.1 at the port asked for, and prints its URL", async () => {
    const { code, output } = await sandbox.runCli(["ui", "start", "--port", String(portA)]);

    expect(code).toBe(0);
    expect(urlIn(output)).toStartWith(`http://127.0.0.1:${portA}/?token=`);
    expect(record()).toEqual({ running: true, port: portA });
    // A random 32-byte token, only the person may read.
    expect(readFileSync(tokenFile(), "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(tokenFile()).mode & 0o777).toBe(0o600);
    expect(tokenIn(urlIn(output))).toBe(readFileSync(tokenFile(), "utf8").trim());

    const page = await fetch(`http://127.0.0.1:${portA}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root">');

    const status = await sandbox.runCli(["ui", "status"]);

    expect(status.output).toContain(`the dashboard is running at http://127.0.0.1:${portA}/`);
  }, 30_000);

  test("the token sets a cookie that lets the page ask /api/status", async () => {
    const token = readFileSync(tokenFile(), "utf8").trim();

    const landing = await fetch(`http://127.0.0.1:${portA}/?token=${token}`, {
      redirect: "manual",
    });

    expect(landing.status).toBe(303);
    expect(landing.headers.get("location")).toBe("/");
    const setCookie = landing.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");

    const status = await fetch(`http://127.0.0.1:${portA}/api/status`, {
      headers: { cookie: setCookie.split(";")[0] ?? "" },
    });

    expect(status.status).toBe(200);
    expect(Schema.decodeUnknownSync(DaemonStatus)(await status.json()).repos.length).toBe(1);
  });

  test("the page's script loads from the listener", async () => {
    const html = await (await fetch(`http://127.0.0.1:${portA}/`)).text();
    const script = html.match(/<script[^>]* src="([^"]+)"/)?.[1] ?? "";
    const bundle = await fetch(new URL(script, `http://127.0.0.1:${portA}/`));

    expect(bundle.status).toBe(200);
    expect(await bundle.text()).toContain("StatusUnavailable");
  });

  describe("refuses", () => {
    const token = () => readFileSync(tokenFile(), "utf8").trim();

    test("an /api/ request without the cookie", async () => {
      expect((await fetch(`http://127.0.0.1:${portA}/api/status`)).status).toBe(401);
    });

    test("a wrong token, and the cookie it would have set", async () => {
      const landing = await fetch(`http://127.0.0.1:${portA}/?token=${"0".repeat(64)}`, {
        redirect: "manual",
      });

      expect(landing.status).toBe(401);
      expect(landing.headers.get("set-cookie")).toBeNull();

      const forged = await fetch(`http://127.0.0.1:${portA}/api/status`, {
        headers: { cookie: `chernabog_dashboard=${"0".repeat(64)}` },
      });

      expect(forged.status).toBe(401);
    });

    test("a request whose Host is foreign, as a rebound DNS name sends", async () => {
      const cookie = await cookieFor(portA, token());

      for (const path of ["/", "/api/status"]) {
        const response = await fetch(`http://127.0.0.1:${portA}${path}`, {
          headers: { cookie, host: `evil.example:${portA}` },
        });

        expect(response.status).toBe(403);
      }

      const localhost = await fetch(`http://127.0.0.1:${portA}/api/status`, {
        headers: { cookie, host: `localhost:${portA}` },
      });

      expect(localhost.status).toBe(200);
    });

    test("a POST from a foreign Origin", async () => {
      const response = await fetch(`http://127.0.0.1:${portA}/api/reload`, {
        method: "POST",
        headers: {
          cookie: await cookieFor(portA, token()),
          origin: "http://evil.example",
          "content-type": "application/json",
        },
        body: "{}",
      });

      expect(response.status).toBe(403);
    });

    test("a form-encoded POST", async () => {
      const response = await fetch(`http://127.0.0.1:${portA}/api/reload`, {
        method: "POST",
        headers: {
          cookie: await cookieFor(portA, token()),
          origin: `http://127.0.0.1:${portA}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "a=b",
      });

      expect(response.status).toBe(415);
    });
  });

  test("answers a same-origin JSON POST through the socket's router", async () => {
    const response = await fetch(`http://127.0.0.1:${portA}/api/reload`, {
      method: "POST",
      headers: {
        cookie: await cookieFor(portA, readFileSync(tokenFile(), "utf8").trim()),
        origin: `http://localhost:${portA}`,
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reloadPending: false });
  });

  test("leaves the socket's own routes off TCP: /dashboard, and anything outside /api/", async () => {
    const cookie = await cookieFor(portA, readFileSync(tokenFile(), "utf8").trim());

    const json = {
      cookie,
      origin: `http://127.0.0.1:${portA}`,
      "content-type": "application/json",
    };

    expect(
      (await fetch(`http://127.0.0.1:${portA}/api/dashboard`, { headers: { cookie } })).status,
    ).toBe(404);

    for (const path of ["/api/dashboard/stop", "/api/dashboard/start"]) {
      const response = await fetch(`http://127.0.0.1:${portA}${path}`, {
        method: "POST",
        headers: json,
        body: "{}",
      });

      expect(response.status).toBe(404);
    }

    expect(
      (await fetch(`http://127.0.0.1:${portA}/dashboard`, { headers: { cookie } })).status,
    ).toBe(404);
    expect((await fetch(`http://127.0.0.1:${portA}/status`, { headers: { cookie } })).status).toBe(
      404,
    );
    // Still running: nothing above reached the socket's /dashboard routes.
    expect(record()).toEqual({ running: true, port: portA });
  });

  test("starting it on another port moves it there", async () => {
    const { code, output } = await sandbox.runCli(["ui", "start", "--port", String(portB)]);

    expect(code).toBe(0);
    expect(urlIn(output)).toStartWith(`http://127.0.0.1:${portB}/?token=`);
    expect(await answers(portA)).toBe(false);
    expect(await answers(portB)).toBe(true);
    expect(record()).toEqual({ running: true, port: portB });
  }, 30_000);

  test("refuses a port in use, and never falls back to another", async () => {
    const taken = freePort();

    await withPortHeld(taken, async () => {
      const { code, output } = await sandbox.runCli(["ui", "start", "--port", String(taken)]);

      expect(code).toBe(1);
      expect(output).toContain(`port ${taken} is in use`);
      expect(await (await fetch(`http://127.0.0.1:${taken}/`)).text()).toBe("someone else");
      // Where it was, as it was.
      expect(await answers(portB)).toBe(true);
      expect(record()).toEqual({ running: true, port: portB });
    });
  }, 30_000);

  test("closing it ends an open /events stream", async () => {
    const cookie = await cookieFor(portB, readFileSync(tokenFile(), "utf8").trim());
    const events = await fetch(`http://127.0.0.1:${portB}/api/events`, { headers: { cookie } });

    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const reader = (events.body ?? new ReadableStream()).getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: snapshot");

    const { code } = await sandbox.runCli(["ui", "stop"]);
    expect(code).toBe(0);

    // The stream ends, cleanly or not, rather than hanging.
    const ended = await Promise.race([
      (async () => {
        for (;;) {
          const chunk = await reader.read().catch(() => ({ done: true }));

          if (chunk.done) {
            return true;
          }
        }
      })(),
      Bun.sleep(10_000).then(() => false),
    ]);

    expect(ended).toBe(true);
  }, 30_000);

  test("ui stop closes it, and keeps its port for the next start", async () => {
    expect(await answers(portB)).toBe(false);
    expect(record()).toEqual({ running: false, port: portB });
    expect((await sandbox.runCli(["ui", "status"])).output).toContain(
      "the dashboard is not running",
    );

    const { output } = await sandbox.runCli(["ui", "start"]);
    expect(urlIn(output)).toStartWith(`http://127.0.0.1:${portB}/?token=`);
  }, 30_000);

  test("a restarted daemon opens it again, with the same token", async () => {
    const token = readFileSync(tokenFile(), "utf8").trim();
    const cookie = await cookieFor(portB, token);

    const listening = `dashboard listening on http://127.0.0.1:${portB}/`;
    const before = sandbox.daemonLog().split(listening).length;

    await stopDaemon();
    expect(await answers(portB)).toBe(false);
    await startDaemon();
    await waitFor(() => sandbox.daemonLog().split(listening).length > before, "the dashboard");

    expect(readFileSync(tokenFile(), "utf8").trim()).toBe(token);

    const status = await fetch(`http://127.0.0.1:${portB}/api/status`, { headers: { cookie } });
    expect(status.status).toBe(200);
  }, 30_000);

  test("a restarted daemon whose port is taken says so and carries on, socket-only", async () => {
    await stopDaemon();

    await withPortHeld(portB, async () => {
      await startDaemon();
      await waitFor(
        () => sandbox.daemonLog().includes(`dashboard: port ${portB} is in use`),
        "the daemon to say the port is taken",
      );

      const { code, output } = await sandbox.runCli(["status"]);
      expect(code).toBe(0);
      expect(output).toContain("demo (dataquail/demo)");
      expect((await sandbox.runCli(["ui", "status"])).output).toContain(
        "the dashboard is not running",
      );
      // What was asked stands, for the next restart.
      expect(record()).toEqual({ running: true, port: portB });
    });
  }, 30_000);

  test("ui starts it if it's off and opens the tokenized URL in the browser; --print prints it", async () => {
    const opened = await sandbox.runCli(["ui", "--port", String(portA)]);

    expect(opened.code).toBe(0);
    expect(await answers(portA)).toBe(true);
    const log = readFileSync(join(sandbox.root, "open.log"), "utf8").trim();
    expect(log).toBe(
      `http://127.0.0.1:${portA}/?token=${readFileSync(tokenFile(), "utf8").trim()}`,
    );

    const printed = await sandbox.runCli(["ui", "--print"]);
    expect(printed.code).toBe(0);
    expect(urlIn(printed.output)).toBe(log);
    // Printing opens nothing.
    expect(readFileSync(join(sandbox.root, "open.log"), "utf8").trim()).toBe(log);
  }, 30_000);

  test("ui --rotate-token writes a new token, and the old cookie stops working", async () => {
    const before = readFileSync(tokenFile(), "utf8").trim();
    const cookie = await cookieFor(portA, before);

    const { code, output } = await sandbox.runCli(["ui", "--rotate-token", "--print"]);

    expect(code).toBe(0);
    const after = readFileSync(tokenFile(), "utf8").trim();
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
    expect(statSync(tokenFile()).mode & 0o777).toBe(0o600);
    expect(tokenIn(urlIn(output))).toBe(after);
    expect(
      (await fetch(`http://127.0.0.1:${portA}/api/status`, { headers: { cookie } })).status,
    ).toBe(401);
    const fresh = await cookieFor(portA, after);
    expect(
      (await fetch(`http://127.0.0.1:${portA}/api/status`, { headers: { cookie: fresh } })).status,
    ).toBe(200);
  }, 30_000);

  test("with no daemon running, each command says so and how to start one", async () => {
    await stopDaemon();

    for (const args of [["ui"], ["ui", "start"], ["ui", "stop"], ["ui", "status"]]) {
      const { code, output } = await sandbox.runCli(args);

      expect(code).toBe(1);
      expect(output).toContain("the daemon is not running (start it with chernabog start");
    }
  }, 30_000);
});
