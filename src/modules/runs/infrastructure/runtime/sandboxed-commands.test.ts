import { Run } from "@chernabog/core";
import { describe, expect } from "bun:test";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { effect } from "../../../../../test/effect-test.ts";
import { Exec, type ExecResult } from "../../../../platform/exec.ts";
import { containerEnvironment, sandboxedSpawner } from "./sandboxed-commands.ts";

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

type Runtime = "docker" | "podman";

// A repo checked out with a worktree and a common git dir, a trusted
// snapshot whose .chernabog/sandbox/ the runtime has built already, and a
// host spawner that records what it is asked to start and starts nothing.
const setUp = (runtime: Runtime, options: { readonly dockerfile?: boolean } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-sandboxed-commands-" });
    const configDir = `${root}/snapshot/.chernabog`;
    const worktree = `${root}/worktree`;
    const common = `${root}/repo/.git`;
    yield* fs.makeDirectory(`${configDir}/sandbox`, { recursive: true });

    if (options.dockerfile !== false) {
      yield* fs.writeFileString(`${configDir}/sandbox/Dockerfile`, "FROM debian:bookworm-slim\n");
    }

    yield* fs.makeDirectory(worktree, { recursive: true });
    yield* fs.makeDirectory(`${common}/hooks`, { recursive: true });
    yield* fs.writeFileString(`${common}/config`, "[core]\n");

    const asked: Array<ReadonlyArray<string>> = [];
    const spawned: Array<ChildProcess.StandardCommand> = [];

    const exec = Exec.of({
      run: (command, args) =>
        Effect.sync(() => {
          asked.push([command, ...args]);

          if (command === "git") {
            return ok(`${common}\n`);
          }

          return ok();
        }),
    });

    const record = (command: ChildProcess.Command): void => {
      if (ChildProcess.isStandardCommand(command)) {
        spawned.push(command);
      } else {
        record(command.left);
        record(command.right);
      }
    };

    const host = ChildProcessSpawner.make((command) => {
      record(command);

      return Effect.fail(
        PlatformError.badArgument({ module: "test", method: "spawn", description: "recorded" }),
      );
    });

    const platform = (yield* Effect.context<FileSystem.FileSystem | Crypto.Crypto>()).pipe(
      Context.add(Exec, exec),
      Context.add(ChildProcessSpawner.ChildProcessSpawner, host),
    );

    const spawner = sandboxedSpawner(
      {
        sandbox: { name: runtime, from: "repo config" },
        settings: { configDir, slug: "Acme/Widgets" },
        user: { uid: Option.some(501), gid: Option.some(20) },
        platform: "darwin",
      },
      platform,
    );

    // Starts `command` as a flow would, in a scope of its own, as the run `run-1`.
    const start = (command: ChildProcess.Command) =>
      Effect.scoped(spawner.spawn(command)).pipe(
        Effect.provideService(Run, {
          flow: "implement",
          runId: "run-1",
          executionId: "execution-1",
          item: { key: "issue-7", title: "Seven", data: {} },
          leaseTtl: 60_000,
        }),
        Effect.exit,
      );

    return { worktree, common, asked, spawned, start };
  });

const gate = (cwd: string) =>
  ChildProcess.make("sh", ["-c", "bun run test"], {
    cwd,
    env: {
      CI: "1",
      PATH: "/Users/alice/.nvm/versions/node/v22/bin:/usr/bin",
      GH_TOKEN: "token-alice",
    },
    extendEnv: true,
    forceKillAfter: "5 seconds",
  });

// The one command the host was asked to start.
const only = (spawned: ReadonlyArray<ChildProcess.StandardCommand>) => {
  expect(spawned).toHaveLength(1);

  return Option.getOrThrow(Arr.head(spawned));
};

const valueAfter = (args: ReadonlyArray<string>, flag: string) =>
  args.filter((_, at) => args[at - 1] === flag);

describe.each(["docker", "podman"] as const)("a sandboxed repo's command on %s", (runtime) => {
  effect("runs in a container from the repo's image, in its worktree, by the runtime's CLI", () =>
    Effect.gen(function* () {
      const { spawned, start, worktree } = yield* setUp(runtime);
      yield* start(gate(worktree));

      const command = only(spawned);
      expect(command.command).toBe(runtime);
      const args = command.args;

      expect(args.slice(0, 4)).toEqual(["run", "-i", "--rm", "--init"]);
      expect(args.slice(-3)).toEqual(["sh", "-c", "bun run test"]);
      expect(args.at(-4)).toStartWith("chernabog-sandbox/acme-widgets:");
      expect(valueAfter(args, "--workdir")).toEqual([worktree]);
      expect(spawned.map((each) => each.options.cwd)).toEqual([worktree]);
    }),
  );

  effect("mounts only the worktree and the common git dir, its config and hooks read-only", () =>
    Effect.gen(function* () {
      const { common, spawned, start, worktree } = yield* setUp(runtime);
      yield* start(gate(worktree));

      expect(valueAfter(only(spawned).args, "--volume")).toEqual([
        `${worktree}:${worktree}`,
        `${common}:${common}`,
        `${common}/config:${common}/config:ro`,
        `${common}/hooks:${common}/hooks:ro`,
      ]);
    }),
  );

  effect("hands the container the command's own variables by name, and no credential", () =>
    Effect.gen(function* () {
      const { spawned, start, worktree } = yield* setUp(runtime);
      yield* start(gate(worktree));

      const command = only(spawned);
      const args = command.args;

      expect(valueAfter(args, "--env")).toEqual(["CI"]);
      expect(args.join(" ")).not.toContain("token-alice");
      // The CLI runs with this process's environment, for its own config.
      expect(command.options.extendEnv).toBe(true);
      expect(command.options.env).toEqual({ CI: "1" });
    }),
  );

  effect("writes as the person", () =>
    Effect.gen(function* () {
      const { spawned, start, worktree } = yield* setUp(runtime);
      yield* start(gate(worktree));

      const args = only(spawned).args;

      if (runtime === "podman") {
        expect(args).toContain("--userns=keep-id");
      } else {
        expect(valueAfter(args, "--user")).toEqual(["501:20"]);
      }
    }),
  );

  effect("labels the container with the run, and removes it by its own label when it ends", () =>
    Effect.gen(function* () {
      const { asked, spawned, start, worktree } = yield* setUp(runtime);
      yield* start(gate(worktree));

      const labels = valueAfter(only(spawned).args, "--label");

      expect(labels).toContain("chernabog.run=run-1");
      const own = labels.find((label) => label.startsWith("chernabog.command=")) ?? "";

      expect(own.length).toBeGreaterThan("chernabog.command=".length);
      expect(asked).toContainEqual([runtime, "ps", "-aq", "--filter", `label=${own}`]);
    }),
  );

  effect("runs each side of a pipe in a container of its own", () =>
    Effect.gen(function* () {
      const { spawned, start, worktree } = yield* setUp(runtime);

      yield* start(
        ChildProcess.make("cat", ["log.txt"], { cwd: worktree, forceKillAfter: "5 seconds" }).pipe(
          ChildProcess.pipeTo(
            ChildProcess.make("grep", ["error"], { cwd: worktree, forceKillAfter: "5 seconds" }),
          ),
        ),
      );

      expect(spawned.map((command) => command.command)).toEqual([runtime, runtime]);
      expect(spawned.map((command) => command.args.slice(-2))).toEqual([
        ["cat", "log.txt"],
        ["grep", "error"],
      ]);
    }),
  );

  effect("refuses a command that names no worktree, and starts nothing on the host", () =>
    Effect.gen(function* () {
      const { spawned, start } = yield* setUp(runtime);

      const exit = yield* start(
        ChildProcess.make("sh", ["-c", "cat ~/.ssh/id_rsa"], { forceKillAfter: "5 seconds" }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(Exit.isFailure(exit) && exit.cause)).toContain("names no worktree");
      expect(spawned).toEqual([]);
    }),
  );

  effect("refuses a repo with no Dockerfile, naming sandbox init, and starts nothing", () =>
    Effect.gen(function* () {
      const { spawned, start, worktree } = yield* setUp(runtime, { dockerfile: false });
      const exit = yield* start(gate(worktree));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(Exit.isFailure(exit) && exit.cause)).toContain("chernabog sandbox init");
      expect(spawned).toEqual([]);
    }),
  );
});

describe("a sandboxed command's environment", () => {
  effect("keeps the variables the command asked for, less PATH, HOME and every credential", () =>
    Effect.sync(() => {
      expect(
        containerEnvironment({
          CI: "1",
          NODE_ENV: "test",
          PATH: "/Users/alice/.nvm/bin:/usr/bin",
          HOME: "/Users/alice",
          GH_TOKEN: "token-alice",
          GITHUB_TOKEN: "token-alice",
          CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
          GIT_CONFIG_COUNT: "3",
        }),
      ).toEqual({ CI: "1", NODE_ENV: "test" });
    }),
  );
});
