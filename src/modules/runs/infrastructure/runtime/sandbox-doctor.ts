// What `chernabog doctor` checks of a repo's sandbox (ADR 24, decision 2):
// the things whose absence refuses a sandboxed session, asked ahead of time,
// each saying how to fix it. The runtime is installed and answers; on macOS
// its VM is running and shares the folders the worktrees and the repo's git
// dir live in; the repo's image builds; a container from it reaches the
// session API; and each Claude account a sandboxed session signs in with has
// its token. A check that fails leaves out the ones that need it, since they
// would only fail for the same reason.

import type { ResolvedSandbox } from "@chernabog/core";
import * as Arr from "effect/Array";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { setTokenCommand, storedClaudeToken } from "../../../../platform/claude-tokens.ts";
import { Exec, type ExecResult } from "../../../../platform/exec.ts";
import { SESSION_API_LOOPBACK } from "../../../../platform/session-token.ts";
import { gatewayArgs, sessionApiHostFor } from "./launchers/container.ts";
import { type BuildUser, SANDBOX_DIR, sandboxImage } from "./sandbox-image.ts";

export type SandboxCheck = {
  readonly ok: boolean;
  readonly label: string;
  readonly fix: string;
};

// A folder a sandboxed session mounts at its own path, and what it is.
export type SandboxShare = { readonly path: string; readonly what: string };

export type SandboxDoctor = {
  readonly sandbox: ResolvedSandbox;
  // The repo, as doctor names it.
  readonly name: string;
  // owner/name, for the image's tag.
  readonly slug: string;
  // The trusted snapshot's .chernabog/.
  readonly configDir: string;
  readonly platform: string;
  readonly user: BuildUser;
  // What a session mounts: the repo's worktrees and its common git dir.
  readonly shares: ReadonlyArray<SandboxShare>;
  // The port of a session API doctor opened as the hub does, or why it couldn't.
  readonly sessionApi: Result.Result<number, string>;
  // The Claude accounts the repo's sandboxed sessions sign in with.
  readonly claudeAccounts: ReadonlyArray<string>;
};

const QUICK: Duration.Input = "30 seconds";

// Long enough for a runtime to pull nothing and start a container from a built image.
const PROBE: Duration.Input = "2 minutes";

const notRun = (message: string): ExecResult => ({ exitCode: 127, stdout: "", stderr: message });

const saidBy = (result: ExecResult) =>
  Option.getOrElse(
    Arr.findFirst([result.stderr.trim(), result.stdout.trim()], (text) => text.length > 0),
    () => `exited ${result.exitCode}`,
  )
    .split("\n")
    .slice(-3)
    .join(" ")
    .slice(0, 300);

type ByPlatform = { readonly darwin: string; readonly linux: string };

const INSTALL: Readonly<Record<"docker" | "podman", ByPlatform>> = {
  docker: {
    darwin: "install Docker Desktop (https://docs.docker.com/desktop/setup/install/mac-install/)",
    linux: "install Docker Engine (https://docs.docker.com/engine/install/)",
  },
  podman: {
    darwin:
      "brew install podman, then podman machine init and podman machine start (https://podman.io/docs/installation)",
    linux: "install podman from your distribution (https://podman.io/docs/installation)",
  },
};

const START: Readonly<Record<"docker" | "podman", ByPlatform>> = {
  docker: {
    darwin: "start Docker Desktop (or the VM your docker CLI talks to, such as Colima's)",
    linux: "sudo systemctl start docker, and add yourself to the docker group",
  },
  podman: {
    darwin: "podman machine start",
    linux: "podman info says what's wrong; for rootless podman, check podman system migrate",
  },
};

const forPlatform = (table: ByPlatform, platform: string) =>
  Option.getOrElse(
    Option.liftPredicate(table.darwin, () => platform === "darwin"),
    () => table.linux,
  );

const SANDBOX_INIT = "chernabog sandbox init, then commit and merge what it writes";

const checkImage = (
  input: SandboxDoctor,
  runtime: "docker" | "podman",
  push: (ok: boolean, label: string, fix: string) => boolean,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dockerfile = `.chernabog/${SANDBOX_DIR}/Dockerfile`;

    const exists = yield* fs
      .exists(`${input.configDir}/${SANDBOX_DIR}/Dockerfile`)
      .pipe(Effect.orElseSucceed(() => false));

    if (!push(exists, `${dockerfile} is on the default branch`, SANDBOX_INIT)) {
      return Option.none<string>();
    }

    const built = yield* Effect.result(
      sandboxImage({
        sandbox: input.sandbox,
        configDir: input.configDir,
        slug: input.slug,
        user: input.user,
        log: () => Effect.void,
      }),
    );

    return Result.match(built, {
      onFailure: (error) => {
        push(
          false,
          `its image builds from ${dockerfile} (${error.message})`,
          `fix ${dockerfile} until ${runtime} build --file ${dockerfile} .chernabog/${SANDBOX_DIR} passes, then commit and merge it`,
        );

        return Option.none<string>();
      },
      onSuccess: (tag) => {
        push(true, `its image builds from ${dockerfile} (${tag})`, "");

        return Option.some(tag);
      },
    });
  });

type Run = (args: ReadonlyArray<string>, timeout: Duration.Input) => Effect.Effect<ExecResult>;

export const shareFix = (runtime: "docker" | "podman", path: string) => {
  if (runtime === "podman") {
    return `recreate podman's machine sharing it: podman machine rm, then podman machine init --volume ${path}:${path} (with every other folder it should share), then podman machine start`;
  }

  return `share ${path} or a folder above it in Docker Desktop's Settings > Resources > File sharing (or your docker VM's mounts), then apply and restart`;
};

// A path a container sees only when the VM shares it: Docker Desktop refuses
// to mount one it doesn't ("Mounts denied"), and podman's machine has none
// of it to mount.
const checkShares = (
  input: SandboxDoctor,
  runtime: "docker" | "podman",
  tag: string,
  run: Run,
  push: (ok: boolean, label: string, fix: string) => boolean,
) =>
  Effect.gen(function* () {
    for (const share of input.shares) {
      const probed = yield* run(
        [
          "run",
          "--rm",
          "--volume",
          `${share.path}:${share.path}:ro`,
          tag,
          "test",
          "-d",
          share.path,
        ],
        PROBE,
      );

      push(
        probed.exitCode === 0,
        `its VM shares ${share.path}, where ${share.what}${Option.getOrElse(
          Option.liftPredicate(` (${saidBy(probed)})`, () => probed.exitCode !== 0),
          () => "",
        )}`,
        shareFix(runtime, share.path),
      );
    }
  });

export const sessionApiFix = (runtime: "docker" | "podman", platform: string) => {
  if (platform === "darwin") {
    return `make sure ${runtime}'s VM forwards ${sessionApiHostFor(runtime, SESSION_API_LOOPBACK)} to this Mac, and that the image has curl (the template installs it)`;
  }

  return `let containers reach this machine at ${sessionApiHostFor(runtime, SESSION_API_LOOPBACK)}: a firewall must allow the container bridge (docker0 or podman0) to reach chernabog's port, and the image must have curl (the template installs it)`;
};

// Any HTTP status means the request reached the listener; curl says 000 when
// it reached nothing.
const answered = (stdout: string) => /^[1-5]\d\d$/.test(stdout.trim());

// A container from the repo's image asks the session API a route that needs
// a token, as a session's hooks would, at the host a session is told.
const checkSessionApi = (
  input: SandboxDoctor,
  runtime: "docker" | "podman",
  tag: string,
  run: Run,
  push: (ok: boolean, label: string, fix: string) => boolean,
) =>
  Effect.gen(function* () {
    const host = sessionApiHostFor(runtime, SESSION_API_LOOPBACK);

    if (Result.isFailure(input.sessionApi)) {
      push(
        false,
        `a session API could be opened for a container to reach (${input.sessionApi.failure})`,
        "free the loopback address, and on Linux the container bridge's, for chernabog to listen on",
      );

      return;
    }

    const url = `http://${host}:${input.sessionApi.success}/runs/doctor/sessions/doctor/stop`;

    const probed = yield* run(
      [
        "run",
        "--rm",
        ...gatewayArgs(runtime, input.platform),
        tag,
        "curl",
        "--silent",
        "--show-error",
        "--max-time",
        "10",
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code}",
        "--request",
        "POST",
        url,
      ],
      PROBE,
    );

    const ok = probed.exitCode === 0 && answered(probed.stdout);

    push(
      ok,
      `a container from its image reaches the session API at ${host}${Option.getOrElse(
        Option.liftPredicate(` (${saidBy(probed)})`, () => !ok),
        () => "",
      )}`,
      sessionApiFix(runtime, input.platform),
    );
  });

const checkRuntime = (
  input: SandboxDoctor,
  runtime: "docker" | "podman",
  checks: Array<SandboxCheck>,
) =>
  Effect.gen(function* () {
    const exec = yield* Exec;
    const prefix = `${input.name}: sandbox ${runtime} (from ${input.sandbox.from})`;
    const darwin = input.platform === "darwin";

    const run = (args: ReadonlyArray<string>, timeout: Duration.Input) =>
      exec
        .run(runtime, args, { timeout })
        .pipe(Effect.catch((error) => Effect.succeed(notRun(error.message))));

    const push = (ok: boolean, label: string, fix: string) => {
      checks.push({ ok, label: `${prefix}: ${label}`, fix });

      return ok;
    };

    const version = yield* run(["--version"], QUICK);

    if (
      !push(
        version.exitCode === 0,
        `${runtime} is installed (${saidBy(version)})`,
        forPlatform(INSTALL[runtime], input.platform),
      )
    ) {
      return;
    }

    // Podman on macOS runs its containers in a machine of its own, which
    // `podman info` can't reach while it's stopped.
    if (darwin && runtime === "podman") {
      const machine = yield* run(["machine", "inspect", "--format", "{{.State}}"], QUICK);
      const state = machine.stdout.trim();

      const said = Option.getOrElse(
        Option.liftPredicate(state, () => machine.exitCode === 0 && state.length > 0),
        () => saidBy(machine),
      );

      if (
        !push(
          machine.exitCode === 0 && state === "running",
          `podman's machine is running (${said})`,
          "podman machine start, or podman machine init first if podman machine list shows none",
        )
      ) {
        return;
      }
    }

    const info = yield* run(["info"], QUICK);

    const answers = Option.getOrElse(
      Option.liftPredicate("answers, so its VM is running", () => darwin && runtime === "docker"),
      () => "answers",
    );

    if (
      !push(
        info.exitCode === 0,
        `${runtime} info ${answers}${Option.getOrElse(
          Option.liftPredicate(` (${saidBy(info)})`, () => info.exitCode !== 0),
          () => "",
        )}`,
        forPlatform(START[runtime], input.platform),
      )
    ) {
      return;
    }

    const image = yield* checkImage(input, runtime, push);

    for (const tag of Option.toArray(image)) {
      if (darwin) {
        yield* checkShares(input, runtime, tag, run, push);
      }

      yield* checkSessionApi(input, runtime, tag, run, push);
    }
  });

export const checkSandbox = (input: SandboxDoctor) =>
  Effect.gen(function* () {
    const checks: Array<SandboxCheck> = [];

    if (input.sandbox.name !== "none") {
      yield* checkRuntime(input, input.sandbox.name, checks);

      for (const account of input.claudeAccounts) {
        const token = yield* storedClaudeToken(account);

        checks.push({
          ok: Option.isSome(token),
          label: `${input.name}: the ${account} account has a Claude token for sandboxed sessions, which can't read this machine's login`,
          fix: `claude setup-token, as the ${account} account, then pipe or paste the token it prints into ${setTokenCommand(account)}`,
        });
      }
    }

    return checks;
  });
