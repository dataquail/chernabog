// Opening a run's session in its launcher, on the daemon's machine, for the
// dashboard's "Open in launcher": Orca switches to its tab, tmux switches a
// client to it, and anything else is refused with why.

import { printJson } from "@chernabog/sdk";
import { expect } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { openRunSession } from "../src/modules/runs/infrastructure/runtime/agents.ts";
import {
  LaunchRecord,
  sessionFiles,
} from "../src/modules/runs/infrastructure/runtime/agents/session-files.ts";
import { recordRunSession } from "../src/modules/runs/infrastructure/runtime/agents/sessions.ts";
import { execTestLayer } from "../src/platform/exec.ts";
import { Home } from "../src/platform/home.ts";
import { effectAtHomeWith } from "./effect-test.ts";

const account = {
  name: "personal",
  configDir: Option.none<string>(),
  expectedEmail: Option.none<string>(),
  oauthTokenEnv: Option.none<string>(),
  usageGate: "usage" as const,
};

// What the fake launchers were asked, and the sessions they still run.
const calls: Array<string> = [];
const running = new Set<string>();

const fakes = execTestLayer((command, args) => {
  calls.push([command, ...args].join(" "));
  const handle = Option.getOrElse(Arr.last(args.filter((arg) => arg !== "--json")), () => "");

  if (command === "tmux" && args[0] === "has-session") {
    return Option.some({ exitCode: Number(!running.has(handle)), stdout: "", stderr: "" });
  }

  if (command === "tmux" && args[0] === "switch-client") {
    if (running.has("no-client")) {
      return Option.some({ exitCode: 1, stdout: "", stderr: "no current client" });
    }

    return Option.some({ exitCode: 0, stdout: "", stderr: "" });
  }

  if (command === "orca" && args[1] === "show") {
    return Option.some({
      exitCode: 0,
      stdout: printJson({
        ok: true,
        result: { terminal: { connected: running.has(handle) } },
      }),
      stderr: "",
    });
  }

  if (command === "orca" && args[1] === "switch") {
    return Option.some({
      exitCode: 0,
      stdout: printJson({ ok: true, result: { switched: handle } }),
      stderr: "",
    });
  }

  return Option.none();
});

const effect = effectAtHomeWith(fakes);

// A launcher of a person's own, which can start and close but not open.
const MINE = {
  start: ["mine", "start", "{command}"],
  close: ["mine", "close", "{handle}"],
  alive: Option.none<ReadonlyArray<string>>(),
  attach: Option.none<ReadonlyArray<string>>(),
};

const RUN = "5714245a-211c-4f0d-8ce1-74b725bac0d6";

// A run whose one session runs under `launcher` with `handle`, or headless.
const sessionUnder = (
  launcher: Option.Option<{ name: string; handle: string; custom?: boolean }>,
) =>
  Effect.gen(function* () {
    calls.length = 0;
    running.clear();
    yield* recordRunSession(RUN, "claude", "abc", "/wt", account);

    for (const launch of Option.toArray(launcher)) {
      const fs = yield* FileSystem.FileSystem;
      const files = sessionFiles((yield* Home).root, "abc");
      yield* fs.makeDirectory(files.dir, { recursive: true });
      yield* fs.writeFileString(
        files.launch,
        yield* Schema.encodeEffect(LaunchRecord)({
          launcher: {
            name: launch.name,
            from: "machine config",
            custom: Option.liftPredicate(MINE, () => launch.custom === true),
          },
          handle: launch.handle,
          at: "2026-10-31T12:00:00.000Z",
        }),
      );
    }
  });

const refusal = (runId: string) =>
  Effect.map(Effect.flip(openRunSession(runId)), (refused) => refused.message);

effect("opens a session still running under tmux by switching a client to it", () =>
  Effect.gen(function* () {
    yield* sessionUnder(Option.some({ name: "tmux", handle: "chernabog-abc" }));
    running.add("=chernabog-abc");

    expect(yield* openRunSession(RUN)).toEqual({ launcher: "tmux", sessionId: "abc" });
    expect(calls).toContain("tmux switch-client -t =chernabog-abc");
  }),
);

effect("opens a session still running in Orca by switching to its terminal", () =>
  Effect.gen(function* () {
    yield* sessionUnder(Option.some({ name: "orca", handle: "term_1" }));
    running.add("term_1");

    expect(yield* openRunSession(RUN)).toEqual({ launcher: "orca", sessionId: "abc" });
    expect(calls).toContain("orca terminal switch --terminal term_1 --json");
  }),
);

effect("refuses a run that opened no session, or one that runs headless", () =>
  Effect.gen(function* () {
    expect(yield* refusal("0000aaaa-0000-0000-0000-000000000000")).toBe(
      "0000aaaa-0000-0000-0000-000000000000 has opened no agent session yet",
    );

    yield* sessionUnder(Option.none());

    expect(yield* refusal(RUN)).toBe(
      "its session runs headless, with no launcher to open it in: copy the attach command and run it in a terminal",
    );
    expect(calls).toEqual([]);
  }),
);

effect("refuses a session whose launcher can't open it, or that has ended", () =>
  Effect.gen(function* () {
    yield* sessionUnder(Option.some({ name: "mine", handle: "h", custom: true }));

    expect(yield* refusal(RUN)).toBe(
      "mine can't open a session itself: copy the attach command and run it in a terminal",
    );

    yield* sessionUnder(Option.some({ name: "tmux", handle: "chernabog-abc" }));

    expect(yield* refusal(RUN)).toBe(
      "its session in tmux has ended: copy the attach command to resume it in a terminal",
    );
    expect(calls.some((call) => call.startsWith("tmux switch-client"))).toBe(false);
  }),
);

effect("says what the launcher said when it fails to open the session", () =>
  Effect.gen(function* () {
    yield* sessionUnder(Option.some({ name: "tmux", handle: "chernabog-abc" }));
    running.add("=chernabog-abc");
    running.add("no-client");

    expect(yield* refusal(RUN)).toBe(
      "tmux couldn't open it: tmux switch-client exited 1: no current client",
    );
  }),
);
