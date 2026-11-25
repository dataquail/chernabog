import { describe, expect } from "bun:test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { effect } from "../../test/effect-test.ts";
import {
  describeExit,
  groupsMemory,
  parseGroupMemory,
  spawnGroup,
  stopGroup,
} from "./process-group.ts";

const sh = (script: string) =>
  spawnGroup("sh", ["-c", script], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" } });

// Whether a process is alive, by its PID: signal 0 reaches it.
const alive = (pid: number) =>
  Effect.try({ try: () => process.kill(pid, 0), catch: () => false }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

// Whether a process is gone within a few seconds: one killed with its group
// is reaped by init once its parent has gone, which signal 0 still reaches
// until then.
const gone = (pid: number) =>
  alive(pid).pipe(
    Effect.repeat({ while: (found) => found, schedule: Schedule.spaced("50 millis"), times: 100 }),
    Effect.map((found) => !found),
  );

describe("spawnGroup", () => {
  effect("runs a command in a group it leads, with its lines, and says how it exited", () =>
    Effect.gen(function* () {
      const group = yield* sh("echo out; echo err >&2; exit 3");
      // Read only once it has written and exited, as a busy parent would.
      yield* group.exited;
      const lines = yield* Stream.runCollect(group.lines);
      const exit = yield* group.exited;

      expect(lines.map((line) => `${line.stream}: ${line.text}`).toSorted()).toEqual([
        "stderr: err",
        "stdout: out",
      ]);
      expect(exit.code).toEqual(Option.some(3));
      expect(exit.signal).toEqual(Option.none());
      expect(describeExit(exit)).toBe("exited 3");
    }),
  );

  effect("hands the child a stdin it reads to its end once the parent closes it", () =>
    Effect.gen(function* () {
      const group = yield* sh("cat >/dev/null; echo stdin closed");

      yield* group.closeStdin;

      const lines = yield* Stream.runCollect(group.lines);

      expect(lines.map((line) => line.text)).toEqual(["stdin closed"]);
      expect((yield* group.exited).code).toEqual(Option.some(0));
    }),
  );

  effect("stops every process in the group, and SIGKILLs one that outlasts the grace", () =>
    Effect.gen(function* () {
      // A leader that ignores SIGTERM, and a child of it that doesn't.
      const group = yield* sh("trap '' TERM; sleep 60 & echo $!; wait; sleep 60");
      const child = Number((yield* Stream.runHead(group.lines)).pipe(Option.getOrThrow).text);

      expect(yield* alive(child)).toBe(true);

      const exit = yield* stopGroup(group, Duration.millis(300));

      expect(exit.signal).toEqual(Option.some("SIGKILL"));
      expect(describeExit(exit)).toBe("killed by SIGKILL");
      expect(yield* gone(child)).toBe(true);
    }),
  );

  effect("says a command it couldn't start, and signals nothing for it", () =>
    Effect.gen(function* () {
      const group = yield* spawnGroup("/no/such/command", [], { cwd: process.cwd(), env: {} });
      const exit = yield* group.exited;

      yield* group.signal("SIGTERM");

      expect(Option.isSome(exit.failedToStart)).toBe(true);
      expect(describeExit(exit)).toStartWith("could not start: ");
    }),
  );
});

describe("groupsMemory", () => {
  effect("sums each group's resident memory, in bytes, from ps's lines", () =>
    Effect.sync(() => {
      const byGroup = parseGroupMemory("  101  2048\n 101 1024\n202   512\n\nnot a line\n");

      expect([...byGroup.entries()]).toEqual([
        [101, 3 * 1024 * 1024],
        [202, 512 * 1024],
      ]);
    }),
  );

  effect("measures a live group: its leader and every child it started", () =>
    Effect.gen(function* () {
      const group = yield* sh("sleep 60 & sleep 60 & wait");

      // ps sees the children once they've started.
      const measured = yield* groupsMemory.pipe(
        Effect.repeat({
          until: (byGroup) => (byGroup.get(group.pid) ?? 0) > 0,
          schedule: Schedule.spaced("50 millis"),
          times: 40,
        }),
      );

      expect(measured.get(group.pid)).toBeGreaterThan(0);

      yield* stopGroup(group, Duration.millis(300));
    }),
  );
});
