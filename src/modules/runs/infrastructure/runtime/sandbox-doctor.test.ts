import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { effectAtHomeWith } from "../../../../../test/effect-test.ts";
import { storeClaudeToken } from "../../../../platform/claude-tokens.ts";
import { type ExecResult, execTestLayer } from "../../../../platform/exec.ts";
import { checkSandbox, type SandboxCheck, type SandboxDoctor } from "./sandbox-doctor.ts";

// A container runtime that answers as `world` says, and records what it was asked.
const world = {
  missing: false,
  machine: "running",
  infoFails: false,
  buildFails: false,
  unshared: new Set<string>(),
  apiAnswers: "401",
};

const calls: Array<ReadonlyArray<string>> = [];

const reset = () => {
  world.missing = false;
  world.machine = "running";
  world.infoFails = false;
  world.buildFails = false;
  world.unshared.clear();
  world.apiAnswers = "401";
  calls.length = 0;
};

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
const failed = (stderr: string, exitCode = 1): ExecResult => ({ exitCode, stdout: "", stderr });

const containerRun = (args: ReadonlyArray<string>): ExecResult => {
  const volume = args.indexOf("--volume");

  if (volume >= 0) {
    const path = (args[volume + 1] ?? "").split(":")[0] ?? "";

    if (world.unshared.has(path)) {
      return failed(
        `docker: Error response from daemon: Mounts denied: The path ${path} is not shared from the host`,
        125,
      );
    }

    return ok();
  }

  if (args.includes("curl")) {
    if (world.apiAnswers === "000") {
      return {
        exitCode: 7,
        stdout: "000",
        stderr: "curl: (7) Failed to connect to host.docker.internal",
      };
    }

    return ok(world.apiAnswers);
  }

  return failed("unexpected run");
};

const answer = (args: ReadonlyArray<string>): ExecResult => {
  if (world.missing) {
    return failed("command not found", 127);
  }

  switch (args[0]) {
    case "--version":
      return ok("docker version 28.0.0\n");
    case "machine":
      return Option.match(
        Option.liftPredicate(world.machine, (state) => state.length > 0),
        {
          onNone: () => failed("Error: podman-machine-default: VM does not exist", 125),
          onSome: (state) => ok(`${state}\n`),
        },
      );
    case "info":
      return Option.getOrElse(
        Option.liftPredicate(
          failed("Cannot connect to the Docker daemon. Is the docker daemon running?"),
          () => world.infoFails,
        ),
        () => ok("info"),
      );
    case "image":
      return failed("Error: No such image");
    case "build":
      return Option.getOrElse(
        Option.liftPredicate(
          failed('ERROR: process "/bin/sh -c false" did not complete successfully'),
          () => world.buildFails,
        ),
        () => ok("built"),
      );
    case "run":
      return containerRun(args);
    default:
      return failed("unknown");
  }
};

const FakeRuntime = execTestLayer((command, args) => {
  calls.push([command, ...args]);

  return Option.some(answer(args));
});

const test = effectAtHomeWith(FakeRuntime);

const WORKTREES = "/Users/me/.config/chernabog/worktrees/widgets";
const GIT_DIR = "/Users/me/code/widgets/.git";

const setUp = (
  runtime: "docker" | "podman",
  given: (runtime: typeof world) => void = () => {},
  overrides: Partial<SandboxDoctor> & { readonly dockerfile?: boolean } = {},
) =>
  Effect.gen(function* () {
    reset();
    given(world);
    const fs = yield* FileSystem.FileSystem;
    const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-sandbox-doctor-" });

    if (overrides.dockerfile !== false) {
      yield* fs.makeDirectory(`${configDir}/sandbox`, { recursive: true });
      yield* fs.writeFileString(`${configDir}/sandbox/Dockerfile`, "FROM debian:bookworm-slim\n");
    }

    return yield* checkSandbox({
      sandbox: { name: runtime, from: "repo config" },
      name: "widgets",
      slug: "acme/widgets",
      configDir,
      user: { uid: Option.some(501), gid: Option.some(20) },
      shares: [
        { path: WORKTREES, what: "its worktrees live" },
        { path: GIT_DIR, what: "its git dir lives" },
      ],
      sessionApi: Result.succeed(4242),
      claudeAccounts: [],
      platform: overrides.platform ?? "darwin",
      ...overrides,
    });
  });

const named = (checks: ReadonlyArray<SandboxCheck>, words: string) =>
  checks.filter((check) => check.label.includes(words));

const only = (checks: ReadonlyArray<SandboxCheck>, words: string) => {
  const found = named(checks, words);

  expect(found).toHaveLength(1);

  return found[0] ?? { ok: false, label: "", fix: "" };
};

describe("doctor's checks of a repo's sandbox", () => {
  test("a repo with no sandbox has nothing to check", () =>
    Effect.gen(function* () {
      const checks = yield* checkSandbox({
        sandbox: { name: "none", from: "default" },
        name: "widgets",
        slug: "acme/widgets",
        configDir: "/nowhere",
        platform: "darwin",
        user: { uid: Option.none(), gid: Option.none() },
        shares: [],
        sessionApi: Result.succeed(1),
        claudeAccounts: ["work"],
      });

      expect(checks).toEqual([]);
      expect(calls).toEqual([]);
    }));

  test("everything that works passes, with nothing to fix", () =>
    Effect.gen(function* () {
      const checks = yield* setUp("podman");

      expect(checks.filter((check) => !check.ok)).toEqual([]);
      expect(checks.map((check) => check.label)).toEqual<Array<unknown>>([
        expect.stringContaining("podman is installed"),
        expect.stringContaining("podman's machine is running"),
        expect.stringContaining("podman info answers"),
        expect.stringContaining(".chernabog/sandbox/Dockerfile is on the default branch"),
        expect.stringContaining("its image builds"),
        expect.stringContaining(`its VM shares ${WORKTREES}`),
        expect.stringContaining(`its VM shares ${GIT_DIR}`),
        expect.stringContaining("reaches the session API at host.containers.internal"),
      ]);
    }));

  test("the runtime is installed, or doctor says how to install it and checks nothing that needs it", () =>
    Effect.gen(function* () {
      const passing = only(yield* setUp("docker"), "docker is installed");
      expect(passing.ok).toBe(true);

      const checks = yield* setUp("docker", (runtime) => {
        runtime.missing = true;
      });

      expect(checks.map((check) => check.ok)).toEqual([false]);
      expect(only(checks, "docker is installed").fix).toContain("install Docker Desktop");

      const linux = yield* setUp(
        "podman",
        (runtime) => {
          runtime.missing = true;
        },
        { platform: "linux" },
      );

      expect(only(linux, "podman is installed").fix).toContain("from your distribution");
    }));

  test("podman's machine is running on macOS, or doctor says to start it", () =>
    Effect.gen(function* () {
      expect(only(yield* setUp("podman"), "machine is running").ok).toBe(true);

      for (const state of ["stopped", ""]) {
        const checks = yield* setUp("podman", (runtime) => {
          runtime.machine = state;
        });

        const machine = only(checks, "podman's machine is running");

        expect(machine.ok).toBe(false);
        expect(machine.fix).toContain("podman machine start");
        expect(named(checks, "podman info")).toEqual([]);
      }

      expect(named(yield* setUp("podman", () => {}, { platform: "linux" }), "machine")).toEqual([]);
      expect(named(yield* setUp("docker"), "podman's machine")).toEqual([]);
    }));

  test("the runtime answers, so on macOS its VM runs, or doctor says how to start it", () =>
    Effect.gen(function* () {
      expect(only(yield* setUp("docker"), "docker info answers, so its VM is running").ok).toBe(
        true,
      );

      const checks = yield* setUp("docker", (runtime) => {
        runtime.infoFails = true;
      });

      const info = only(checks, "docker info answers");

      expect(info.ok).toBe(false);
      expect(info.label).toContain("Cannot connect to the Docker daemon");
      expect(info.fix).toContain("start Docker Desktop");
      expect(named(checks, "image")).toEqual([]);

      const linux = yield* setUp(
        "docker",
        (runtime) => {
          runtime.infoFails = true;
        },
        { platform: "linux" },
      );

      expect(only(linux, "docker info answers").fix).toContain("systemctl start docker");
    }));

  test("the repo has a Dockerfile, or doctor says to run sandbox init", () =>
    Effect.gen(function* () {
      const checks = yield* setUp("docker", () => {}, { dockerfile: false });
      const dockerfile = only(checks, "Dockerfile is on the default branch");

      expect(dockerfile.ok).toBe(false);
      expect(dockerfile.fix).toContain("chernabog sandbox init");
      expect(named(checks, "its image builds")).toEqual([]);
    }));

  test("the image builds, or doctor quotes the build and says to fix the Dockerfile", () =>
    Effect.gen(function* () {
      const built = only(yield* setUp("docker"), "its image builds");

      expect(built.ok).toBe(true);
      expect(built.label).toContain("chernabog-sandbox/acme-widgets:");

      const checks = yield* setUp("docker", (runtime) => {
        runtime.buildFails = true;
      });

      const failing = only(checks, "its image builds");

      expect(failing.ok).toBe(false);
      expect(failing.label).toContain("did not complete successfully");
      expect(failing.fix).toContain("fix .chernabog/sandbox/Dockerfile");
      expect(named(checks, "shares")).toEqual([]);
      expect(named(checks, "session API")).toEqual([]);
    }));

  test("on macOS, the VM shares each folder a session mounts, or doctor says how to share it", () =>
    Effect.gen(function* () {
      const docker = yield* setUp("docker", (runtime) => {
        runtime.unshared.add(WORKTREES);
      });

      const worktrees = only(docker, `shares ${WORKTREES}`);
      expect(worktrees.ok).toBe(false);
      expect(worktrees.label).toContain("Mounts denied");
      expect(worktrees.fix).toContain("File sharing");
      expect(only(docker, `shares ${GIT_DIR}`).ok).toBe(true);

      const podman = yield* setUp("podman", (runtime) => {
        runtime.unshared.add(GIT_DIR);
      });

      const gitDir = only(podman, `shares ${GIT_DIR}`);
      expect(gitDir.ok).toBe(false);
      expect(gitDir.fix).toContain(`podman machine init --volume ${GIT_DIR}:${GIT_DIR}`);

      // Linux mounts the host's own folders, with no VM between.
      expect(named(yield* setUp("docker", () => {}, { platform: "linux" }), "shares")).toEqual([]);
    }));

  test("a container from the image reaches the session API, or doctor says what to let through", () =>
    Effect.gen(function* () {
      expect(only(yield* setUp("docker"), "reaches the session API").ok).toBe(true);

      const asked = calls.find((call) => call.includes("curl")) ?? [];
      expect(asked.at(-1)).toBe(
        "http://host.docker.internal:4242/runs/doctor/sessions/doctor/stop",
      );

      const linux = yield* setUp("docker", () => {}, { platform: "linux" });
      expect(only(linux, "reaches the session API").ok).toBe(true);
      expect(calls.find((call) => call.includes("curl"))).toContain(
        "--add-host=host.docker.internal:host-gateway",
      );

      const unreached = only(
        yield* setUp("docker", (runtime) => {
          runtime.apiAnswers = "000";
        }),
        "reaches the session API",
      );

      expect(unreached.ok).toBe(false);
      expect(unreached.label).toContain("Failed to connect");
      expect(unreached.fix).toContain("host.docker.internal");

      const unopened = only(
        yield* setUp("podman", () => {}, {
          platform: "linux",
          sessionApi: Result.fail("can't listen on 127.0.0.1: in use"),
        }),
        "session API",
      );

      expect(unopened.ok).toBe(false);
      expect(unopened.label).toContain("in use");
      expect(unopened.fix).toContain("listen on");
    }));

  test("each Claude account a sandboxed session signs in with has its token, or doctor says how to give it one", () =>
    Effect.gen(function* () {
      yield* storeClaudeToken("work", "sk-ant-oat01-token");

      const checks = yield* setUp("docker", () => {}, { claudeAccounts: ["work", "home"] });

      expect(only(checks, "the work account has a Claude token").ok).toBe(true);

      const missing = only(checks, "the home account has a Claude token");
      expect(missing.ok).toBe(false);
      expect(missing.fix).toContain("claude setup-token");
      expect(missing.fix).toContain("chernabog accounts set-token home");

      // A runtime that's missing leaves the token to check all the same.
      const without = yield* setUp(
        "docker",
        (runtime) => {
          runtime.missing = true;
        },
        { claudeAccounts: ["home"] },
      );

      expect(only(without, "the home account has a Claude token").ok).toBe(false);
    }));
});
