// Orca finds a new worktree by itself, a few seconds after it is made; until
// then `terminal create` on it answers selector_not_found, and the launcher waits.

import { printJson } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { orcaLauncher } from "../src/modules/runs/infrastructure/runtime/launchers/orca.ts";
import { execTestLayer } from "../src/platform/exec.ts";
import { effectOnTestClock } from "./effect-test.ts";

const notFound = printJson({
  ok: false,
  error: { code: "selector_not_found", message: "selector_not_found" },
});

const created = printJson({ ok: true, result: { terminal: { handle: "term_1" } } });

// Answers `terminal create` with selector_not_found the first `misses` times, then with `then`.
const orcaThatFinds = (misses: number, then = created) => {
  const calls = { create: 0 };

  const layer = execTestLayer((command, args) => {
    if (command !== "orca" || args[0] !== "terminal" || args[1] !== "create") {
      return Option.none();
    }

    calls.create += 1;

    if (calls.create <= misses) {
      return Option.some({ exitCode: 0, stdout: notFound, stderr: "" });
    }

    return Option.some({ exitCode: 0, stdout: then, stderr: "" });
  });

  return { calls, layer };
};

const startIn = (layer: ReturnType<typeof orcaThatFinds>["layer"], logged: Array<string>) =>
  orcaLauncher
    .start({
      title: "chernabog-test",
      cwd: "/work/new-worktree",
      command: ["true"],
      log: (line) => Effect.sync(() => logged.push(line)),
    })
    .pipe(Effect.provide(layer), Effect.forkChild);

describe("orca launcher start", () => {
  effectOnTestClock("waits for Orca to find a new worktree, and says so", () =>
    Effect.gen(function* () {
      const orca = orcaThatFinds(3);
      const logged: Array<string> = [];
      const started = yield* startIn(orca.layer, logged);

      yield* TestClock.adjust("10 seconds");

      expect(yield* Fiber.join(started)).toBe("term_1");
      expect(orca.calls.create).toBe(4);
      expect(logged).toEqual([
        "orca: waiting for Orca to find the worktree /work/new-worktree (up to 30 seconds)",
      ]);
    }),
  );

  effectOnTestClock("fails as before once Orca hasn't found it in 30 seconds", () =>
    Effect.gen(function* () {
      const orca = orcaThatFinds(Number.POSITIVE_INFINITY);
      const logged: Array<string> = [];
      const started = yield* startIn(orca.layer, logged);

      yield* TestClock.adjust("29 seconds");
      expect(started.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust("5 seconds");
      const failed = yield* Effect.flip(Fiber.join(started));

      expect(failed.message).toBe("orca terminal create: selector_not_found");
      expect(orca.calls.create).toBeGreaterThan(2);
    }),
  );

  effectOnTestClock("fails at once on any other error", () =>
    Effect.gen(function* () {
      const orca = orcaThatFinds(
        0,
        printJson({ ok: false, error: { code: "invalid_argument", message: "bad title" } }),
      );

      const logged: Array<string> = [];
      const started = yield* startIn(orca.layer, logged);
      const failed = yield* Effect.flip(Fiber.join(started));

      expect(failed.message).toBe("orca terminal create: bad title");
      expect(orca.calls.create).toBe(1);
      expect(logged).toEqual([]);
    }),
  );
});
