// Claude as an interactive session under each launcher, end to end: the answer
// it sends and the Stop hook, both through the hub's session API, decide when
// it is done, and nothing runs `claude -p`.

import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { LaunchRecord } from "../../src/modules/runs/infrastructure/runtime/agents/session-files.ts";
import { closed, openSandbox, type Sandbox, SANDBOX_DOCKERFILE, waitFor } from "./sandbox.ts";

const sandboxes: Array<Sandbox> = [];

const sandboxFor = (...args: Parameters<typeof openSandbox>) => {
  const sandbox = openSandbox(...args);
  sandboxes.push(sandbox);

  return sandbox;
};

// A failed test can leave a fake session idling; end them all.
const endSessions = (sandbox: Sandbox) => {
  for (const dir of ["tmux", "orca"]) {
    if (!existsSync(join(sandbox.root, dir))) {
      continue;
    }

    // kill(1) rather than process.kill, which throws for a session already
    // ended. The `--` matters: procps' kill reads `-9 -1676` as `kill(-1)`,
    // every process the user owns, CI's runner among them.
    for (const pidFile of new Bun.Glob("*.pid").scanSync(join(sandbox.root, dir))) {
      Bun.spawnSync([
        "kill",
        "-9",
        "--",
        `-${readFileSync(join(sandbox.root, dir, pidFile), "utf8")}`,
      ]);
    }
  }
};

afterAll(async () => {
  sandboxes.forEach(endSessions);
  await Promise.all(sandboxes.map((sandbox) => sandbox.github.stop()));
});

const headlessCalls = (sandbox: Sandbox) =>
  sandbox.claudeCalls().filter((call) => call.split(" ")[2] === "-p");

// Ends the fake tmux session, as closing its terminal would.
const killTmuxSession = (sandbox: Sandbox) => {
  const [pidFile = ""] = [...new Bun.Glob("*.pid").scanSync(join(sandbox.root, "tmux"))];
  process.kill(-Number(readFileSync(join(sandbox.root, "tmux", pidFile), "utf8")), "SIGKILL");
};

const launchRecorded = (sandbox: Sandbox) =>
  [...new Bun.Glob("*/launch.json").scanSync(join(sandbox.home, "sessions/interactive"))].length >
  0;

// The Stop hook in a session's settings file.
const StopHookOf = Schema.fromJsonString(
  Schema.Struct({
    hooks: Schema.Struct({
      Stop: Schema.Array(
        Schema.Struct({
          hooks: Schema.Array(
            Schema.Struct({
              type: Schema.String,
              url: Schema.String,
              headers: Schema.Record(Schema.String, Schema.String),
            }),
          ),
        }),
      ),
    }),
  }),
);

const CUSTOM = {
  start: ["tmux", "new-session", "-d", "-s", "{title}", "-c", "{cwd}", "sh", "-c", "{command}"],
  close: ["tmux", "kill-session", "-t", "{handle}"],
  alive: ["tmux", "has-session", "-t", "{handle}"],
};

describe.each(["tmux", "orca", "mine", "headless"])(
  "implement with the %s launcher",
  (launcher) => {
    test("takes a queued issue to a green pull request handed off for review", async () => {
      const sandbox = sandboxFor({}, { launcher, launchers: { mine: CUSTOM } });
      sandbox.github.addIssue("Do the thing", ["auto:eligible"]);
      const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
      expect(output).toContain("done: #1:");
      expect(code).toBe(0);
      expect(Option.getOrThrow(sandbox.github.firstPull()).labels).toContain("auto:needs-review");
      expect(sandbox.claudeCalls()).toHaveLength(1);

      if (launcher === "headless") {
        expect(headlessCalls(sandbox)).toHaveLength(1);

        return;
      }

      expect(headlessCalls(sandbox)).toHaveLength(0);
      expect(sandbox.hookCalls().map((call) => call.split(" ")[2])).toEqual(["allow"]);

      // It sent its answer to the session API, and its Stop hook is an HTTP
      // hook there: no hook runs the chernabog binary.
      expect(sandbox.answerCalls().map((call) => call.split(" ").slice(2).join(" "))).toEqual([
        "exited 0",
      ]);

      const sessions = join(sandbox.home, "sessions/interactive");

      for (const file of new Bun.Glob("*/settings.json").scanSync(sessions)) {
        const settings = readFileSync(join(sessions, file), "utf8");

        const stop = Schema.decodeSync(StopHookOf)(settings).hooks.Stop[0]?.hooks[0];

        expect(stop.type).toBe("http");
        expect(stop.url).toMatch(
          /^http:\/\/127\.0\.0\.1:\d+\/runs\/[\da-f-]+\/sessions\/[\da-f-]+\/stop$/,
        );
        expect(stop.headers).toEqual({ Authorization: "Bearer $CHERNABOG_SESSION_TOKEN" });
        expect(settings).not.toContain("__stop-hook");
      }

      // The session is closed once it has answered.
      const closes = [
        ...sandbox.tmuxCalls().filter((call) => call.startsWith("kill-session")),
        ...sandbox.orcaCalls().filter((call) => call === "terminal close"),
      ];

      expect(closes).toHaveLength(1);

      // The spec holds the session's environment, so only its owner reads it.
      const specs = [
        ...new Bun.Glob("*/spec.json").scanSync(join(sandbox.home, "sessions/interactive")),
      ];

      expect(
        specs.map(
          (spec) => statSync(join(sandbox.home, "sessions/interactive", spec)).mode & 0o777,
        ),
      ).toEqual([0o600]);

      // The launch record names the run that launched the session, which the
      // hub's session API checks a route's run against.
      const db = new Database(join(sandbox.home, "state.db"), { readonly: true });
      const runs = db.query<{ id: string }, []>("SELECT id FROM om_runs").all();
      db.close();

      const recorded = [
        ...new Bun.Glob("*/launch.json").scanSync(join(sandbox.home, "sessions/interactive")),
      ].map((file) =>
        Schema.decodeSync(LaunchRecord)(
          readFileSync(join(sandbox.home, "sessions/interactive", file), "utf8"),
        ),
      );

      expect(recorded.map((record) => record.runId)).toEqual(runs.map((run) => run.id));

      // It carries the repo's sandbox to __launch: none, when nothing sets one.
      for (const spec of specs) {
        expect(readFileSync(join(sandbox.home, "sessions/interactive", spec), "utf8")).toContain(
          '"sandbox":"none"',
        );
      }
    }, 60_000);
  },
);

// What fakebin's runtime records of a `run`: its arguments.
const RunArgs = Schema.fromJsonString(Schema.Array(Schema.String));

// What a session's container is labelled with, beside the run's.
const SESSION_CONTAINER = '"chernabog.session=';

// What a sandboxed session's launch spec says of where it runs.
const SandboxedSpec = Schema.fromJsonString(
  Schema.Struct({
    cwd: Schema.String,
    env: Schema.Record(Schema.String, Schema.String),
    container: Schema.Struct({
      mounts: Schema.Array(Schema.Struct({ path: Schema.String })),
    }),
  }),
);

const CONTAINER_HOST = {
  docker: "host.docker.internal",
  podman: "host.containers.internal",
} as const;

const USER_MAPPING = {
  docker: `${process.getuid?.()}:${process.getgid?.()}`,
  podman: "--userns=keep-id",
} as const;

// A token as `claude setup-token` prints one.
const CLAUDE_TOKEN = "sk-ant-oat01-sandboxed-session-token";

// What a sandboxed session's env may hold (ADR 24, decision 7): Claude's
// config dir and token, the persona's GH_TOKEN and the git config that
// answers github.com with it, who commits are by, and its session API's
// URL and token (and with a person, its session dir).
const SANDBOXED_VARIABLE =
  /^(CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|GH_TOKEN|GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)|CHERNABOG_SESSION(_URL|_TOKEN)?)$/;

// ADR 24: with a docker or podman sandbox, __launch runs the agent in a
// container (here fakebin's runtime, which runs it on the host as a
// container would), and a sandbox that can't start refuses the run, never
// falling back to the host (decision 2).
describe.each(["docker", "podman"] as const)("a repo whose sandbox is %s", (provider) => {
  const runtimeEnv = (sandbox: Sandbox) => ({
    FAKE_RUNTIME_LOG: join(sandbox.root, "runtime.log"),
    FAKE_RUNTIME_STATE: join(sandbox.root, "runtime"),
  });

  const runtimeCalls = (sandbox: Sandbox) => {
    if (!existsSync(join(sandbox.root, "runtime.log"))) {
      return [];
    }

    return readFileSync(join(sandbox.root, "runtime.log"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
  };

  test("runs the session in a container, under the launcher, through the session API", async () => {
    const sandbox = sandboxFor(
      { sandbox: provider },
      { launcher: "tmux", github: ["alice"], personas: ["alice"] },
    );

    sandbox.github.addIssue("Do the thing", ["auto:eligible"]);

    // The account's Claude token, from `claude setup-token`, piped in.
    const stored = await sandbox.runCliWithInput(
      ["accounts", "set-token", "work"],
      `${CLAUDE_TOKEN}\n`,
    );

    expect(stored.output).not.toContain(CLAUDE_TOKEN);
    expect(stored.code).toBe(0);

    const { code, output } = await sandbox.runCli(
      ["run", "implement", "--repo", "demo", "--as", "alice"],
      {
        ...runtimeEnv(sandbox),
        // A host's own credentials, none of which reach the container.
        ANTHROPIC_API_KEY: "host-api-key",
        AWS_SECRET_ACCESS_KEY: "host-aws-secret",
        SSH_AUTH_SOCK: join(sandbox.root, "ssh-agent.sock"),
      },
    );

    expect(output).toContain("done: #1:");
    expect(code).toBe(0);
    expect(sandbox.claudeCalls()).toHaveLength(1);
    expect(sandbox.answerCalls().map((call) => call.split(" ").slice(2).join(" "))).toEqual([
      "exited 0",
    ]);

    // The session's container; the install and local gate run in their own (#722).
    const runs = runtimeCalls(sandbox)
      .filter((call) => call.startsWith(`${provider} run `) && call.includes(SESSION_CONTAINER))
      .map((call) => Schema.decodeSync(RunArgs)(call.slice(`${provider} run `.length)));

    expect(runs).toHaveLength(1);

    const [args = []] = runs;

    expect(args.slice(0, 3)).toEqual(["-i", "--rm", "--init"]);
    // In the repo's own image, built from its .chernabog/sandbox/Dockerfile.
    const image = args.findIndex((arg) => arg.startsWith("chernabog-sandbox/dataquail-demo:"));

    expect(image).toBeGreaterThan(0);
    expect(args[image + 1]).toBe("claude");

    // Labelled with its run and session, which cancel and the sweep remove it by.
    const [specFile = ""] = [
      ...new Bun.Glob("*/spec.json").scanSync(join(sandbox.home, "sessions/interactive")),
    ];

    const [sessionId = ""] = specFile.split("/");

    expect(args).toContain(`chernabog.session=${sessionId}`);
    expect(args.some((arg) => /^chernabog\.run=[\da-f-]+$/.test(arg))).toBe(true);

    // The worktree, the repo's common git dir and the session's own config
    // dir, each at its host path, and nothing else of the home.
    const spec = Schema.decodeSync(SandboxedSpec)(
      readFileSync(join(sandbox.home, "sessions/interactive", specFile), "utf8"),
    );

    const volumes = args.filter((_, at) => args[at - 1] === "--volume");

    for (const volume of volumes) {
      const [from, to] = volume.split(":");

      expect(to).toBe(from);
    }

    const mounted = spec.container.mounts.map((mount) => mount.path);

    expect(mounted).toContain(spec.cwd);
    // At the path git names it by from the worktree's .git file: its real path.
    expect(mounted).toContain(realpathSync(join(sandbox.checkout, ".git")));
    expect(
      mounted
        .filter((path) => path.startsWith(sandbox.home) && path !== spec.cwd)
        .map((path) => path.slice(sandbox.home.length)),
    ).toEqual([
      `/sessions/interactive/${sessionId}/claude`,
      `/sessions/interactive/${sessionId}/settings.json`,
    ]);
    expect(volumes.filter((volume) => volume.endsWith(":ro")).length).toBeGreaterThanOrEqual(2);

    // Exactly the spec's environment, each variable by name, so no token is
    // on the command line; none of it is the host's PATH or HOME.
    expect(args.filter((_, at) => args[at - 1] === "--env").sort()).toEqual(
      Object.keys(spec.env).sort(),
    );
    expect(Object.keys(spec.env)).not.toContain("PATH");
    expect(Object.keys(spec.env)).not.toContain("HOME");
    expect(args.join(" ")).not.toContain(spec.env.CHERNABOG_SESSION_TOKEN);

    // Signed in to Claude as the repo's account and to gh as its persona,
    // and no other credential: neither token is on the command line.
    expect(spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(CLAUDE_TOKEN);
    expect(spec.env.GH_TOKEN).toBe("token-alice");
    expect(args.join(" ")).not.toContain(CLAUDE_TOKEN);
    expect(args.join(" ")).not.toContain("token-alice");
    expect(Object.keys(spec.env).filter((name) => !SANDBOXED_VARIABLE.test(name))).toEqual([]);

    // It reaches the hub at the runtime's name for the host.
    expect(spec.env.CHERNABOG_SESSION_URL).toStartWith(`http://${CONTAINER_HOST[provider]}:`);
    expect(spec.env.CLAUDE_CONFIG_DIR).toBe(
      join(sandbox.home, "sessions/interactive", sessionId, "claude"),
    );

    // Commits come out owned by the person.
    expect(args).toContain(USER_MAPPING[provider]);
  }, 60_000);

  // A machine with no github: personas: the session acts as the implicit
  // one, whose gh login a container can't reach, so it gets that login's token.
  test("signs a session as the implicit persona in to gh with its login's token", async () => {
    const sandbox = sandboxFor({ sandbox: provider }, { launcher: "tmux" });

    sandbox.github.addIssue("Do the thing", ["auto:eligible"]);
    await sandbox.runCliWithInput(["accounts", "set-token", "work"], `${CLAUDE_TOKEN}\n`);

    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"], {
      ...runtimeEnv(sandbox),
      GH_TOKEN: "token-implicit",
      GITHUB_TOKEN: "host-github-token",
    });

    expect(output).toContain("done: #1:");
    expect(code).toBe(0);

    const [specFile = ""] = [
      ...new Bun.Glob("*/spec.json").scanSync(join(sandbox.home, "sessions/interactive")),
    ];

    const spec = Schema.decodeSync(SandboxedSpec)(
      readFileSync(join(sandbox.home, "sessions/interactive", specFile), "utf8"),
    );

    expect(spec.env.GH_TOKEN).toBe("token-implicit");
    expect(spec.env.GIT_CONFIG_VALUE_2).toContain("$GH_TOKEN");
    expect(spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(CLAUDE_TOKEN);
    expect(Object.keys(spec.env)).not.toContain("GITHUB_TOKEN");
    expect(Object.keys(spec.env).filter((name) => !SANDBOXED_VARIABLE.test(name))).toEqual([]);

    const runs = runtimeCalls(sandbox).filter(
      (call) => call.startsWith(`${provider} run `) && call.includes(SESSION_CONTAINER),
    );

    expect(runs).toHaveLength(1);
    expect(runs.join(" ")).not.toContain("token-implicit");
    expect(runs.join(" ")).not.toContain(CLAUDE_TOKEN);
  }, 60_000);

  test("refuses the session when the repo's account has no Claude token, saying how to set one", async () => {
    const sandbox = sandboxFor({ sandbox: provider }, { launcher: "tmux" });
    sandbox.github.addIssue("Do the thing", ["auto:eligible"]);

    const { output } = await sandbox.runCli(["run", "implement", "--repo", "demo"], {
      ...runtimeEnv(sandbox),
    });

    expect(output).toContain("account work has no Claude token");
    expect(output).toContain("claude setup-token");
    expect(output).toContain("chernabog accounts set-token work");
    expect(sandbox.claudeCalls()).toHaveLength(0);
    expect(runtimeCalls(sandbox).filter((call) => call.startsWith(`${provider} run `))).toEqual([]);
    expect(sandbox.tmuxCalls()).toHaveLength(0);
  }, 60_000);

  test("refuses the session when the runtime isn't there, saying why, and never starts the agent", async () => {
    const sandbox = sandboxFor({ sandbox: provider }, { launcher: "tmux" });
    sandbox.github.addIssue("Do the thing", ["auto:eligible"]);

    const { output } = await sandbox.runCli(["run", "implement", "--repo", "demo"], {
      ...runtimeEnv(sandbox),
      FAKE_RUNTIME_MISSING: "1",
    });

    expect(output).toContain(
      `sandbox ${provider} (from repo config) can't start: \`${provider} info\` failed`,
    );
    expect(sandbox.claudeCalls()).toHaveLength(0);
    // Refused before any session was opened, so nothing reached the launcher.
    expect(existsSync(join(sandbox.home, "sessions/interactive"))).toBe(false);
    expect(sandbox.tmuxCalls()).toHaveLength(0);
  }, 60_000);

  const builds = (sandbox: Sandbox) =>
    runtimeCalls(sandbox)
      .filter((call) => call.startsWith(`${provider} build `))
      .map((call) => Schema.decodeSync(RunArgs)(call.slice(`${provider} build `.length)));

  const runImplement = (sandbox: Sandbox, title: string) => {
    sandbox.github.addIssue(title, ["auto:eligible"]);

    return sandbox.runCli(["run", "implement", "--repo", "demo"], runtimeEnv(sandbox));
  };

  // A change to the image merged on the default branch, the tree it's built from.
  const mergeDockerfile = (sandbox: Sandbox, dockerfile: string) => {
    writeFileSync(join(sandbox.checkout, ".chernabog/sandbox/Dockerfile"), dockerfile);
    sandbox.git(sandbox.checkout, "commit", "-qam", "chore: change the sandbox image");
    sandbox.git(sandbox.checkout, "push", "-q", "origin", "main");
  };

  // #719: built once per content of .chernabog/sandbox/, as the person.
  test("builds the repo's image for its first session, reuses it, and rebuilds it once its Dockerfile changes", async () => {
    const sandbox = sandboxFor({ sandbox: provider }, { launcher: "tmux" });
    await sandbox.runCliWithInput(["accounts", "set-token", "work"], `${CLAUDE_TOKEN}\n`);

    const first = await runImplement(sandbox, "First");

    expect(first.output).toMatch(/done: #\d+:/);

    const [build = [], ...more] = builds(sandbox);

    expect(more).toEqual([]);
    expect(build).toContain(`AGENT_UID=${process.getuid?.()}`);
    expect(build).toContain(`AGENT_GID=${process.getgid?.()}`);
    expect(build.at(-1)).toEndWith("/.chernabog/sandbox");

    const tag = build[build.indexOf("--tag") + 1] ?? "";

    expect(tag).toStartWith("chernabog-sandbox/dataquail-demo:");

    const second = await runImplement(sandbox, "Second");

    expect(second.output).toMatch(/done: #\d+:/);
    expect(builds(sandbox)).toHaveLength(1);

    mergeDockerfile(sandbox, `${SANDBOX_DOCKERFILE}RUN apt-get update\n`);

    const third = await runImplement(sandbox, "Third");

    expect(third.output).toMatch(/done: #\d+:/);

    const rebuilt = builds(sandbox);

    expect(rebuilt).toHaveLength(2);

    const [, again = []] = rebuilt;

    expect(again[again.indexOf("--tag") + 1]).not.toBe(tag);

    const images = runtimeCalls(sandbox)
      .filter((call) => call.startsWith(`${provider} run `) && call.includes(SESSION_CONTAINER))
      .map((call) =>
        Schema.decodeSync(RunArgs)(call.slice(`${provider} run `.length)).find((arg) =>
          arg.startsWith("chernabog-sandbox/"),
        ),
      );

    expect(images).toEqual([tag, tag, again[again.indexOf("--tag") + 1]]);
  }, 120_000);

  test("refuses the session when the image fails to build, with the build's error in the run's log", async () => {
    const sandbox = sandboxFor(
      { sandbox: provider },
      { launcher: "tmux", repoFiles: { "sandbox/Dockerfile": `${SANDBOX_DOCKERFILE}RUN false\n` } },
    );

    await sandbox.runCliWithInput(["accounts", "set-token", "work"], `${CLAUDE_TOKEN}\n`);

    const { output } = await runImplement(sandbox, "Do the thing");

    expect(output).toContain(`\`${provider} build\` of .chernabog/sandbox/Dockerfile failed`);
    expect(output).toContain('process "/bin/sh -c false" did not complete successfully');
    expect(sandbox.claudeCalls()).toHaveLength(0);
    expect(runtimeCalls(sandbox).filter((call) => call.startsWith(`${provider} run `))).toEqual([]);
    expect(sandbox.tmuxCalls()).toHaveLength(0);

    const [log = ""] = [...new Bun.Glob("*.log").scanSync(join(sandbox.home, "runs"))];

    expect(readFileSync(join(sandbox.home, "runs", log), "utf8")).toContain(
      'process "/bin/sh -c false" did not complete successfully',
    );
  }, 60_000);

  test("refuses the session when the repo has no Dockerfile, pointing at sandbox init", async () => {
    const sandbox = sandboxFor({ sandbox: provider }, { launcher: "tmux", noDockerfile: true });
    await sandbox.runCliWithInput(["accounts", "set-token", "work"], `${CLAUDE_TOKEN}\n`);

    const { output } = await runImplement(sandbox, "Do the thing");

    expect(output).toContain("no .chernabog/sandbox/Dockerfile");
    expect(output).toContain("chernabog sandbox init");
    expect(sandbox.claudeCalls()).toHaveLength(0);
    expect(runtimeCalls(sandbox).filter((call) => !call.startsWith(`${provider} info`))).toEqual(
      [],
    );
  }, 60_000);

  test("refuses a headless session, which runs no container yet", async () => {
    const sandbox = sandboxFor({ sandbox: provider }, { launcher: "headless" });
    sandbox.github.addIssue("Do the thing", ["auto:eligible"]);

    const { output } = await sandbox.runCli(["run", "implement", "--repo", "demo"], {
      ...runtimeEnv(sandbox),
    });

    expect(output).toContain("only under a launcher");
    expect(sandbox.claudeCalls()).toHaveLength(0);
  }, 60_000);
});

// Decision 7: each Claude account's token for sandboxed sessions, kept in the
// chernabog home, readable only by its owner, and never on a command line.
describe("chernabog accounts set-token", () => {
  test("keeps the token it reads from stdin for the account, readable only by its owner", async () => {
    const sandbox = sandboxFor();

    const { code, output } = await sandbox.runCliWithInput(
      ["accounts", "set-token", "work"],
      `  ${CLAUDE_TOKEN}\n`,
    );

    expect(code).toBe(0);
    expect(output).toContain("work");
    expect(output).not.toContain(CLAUDE_TOKEN);

    const file = join(sandbox.home, "keys/claude/work.token");

    expect(readFileSync(file, "utf8")).toBe(CLAUDE_TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(sandbox.home, "keys/claude")).mode & 0o777).toBe(0o700);

    // Setting it again replaces it.
    await sandbox.runCliWithInput(["accounts", "set-token", "work"], "sk-ant-oat01-another\n");
    expect(readFileSync(file, "utf8")).toBe("sk-ant-oat01-another");
  }, 60_000);

  test("refuses an account machine config doesn't name, one that isn't Claude's, or no token", async () => {
    const sandbox = sandboxFor();

    const unknown = await sandbox.runCliWithInput(
      ["accounts", "set-token", "nobody"],
      `${CLAUDE_TOKEN}\n`,
    );

    expect(unknown.code).not.toBe(0);
    expect(unknown.output).toContain('account "nobody" is not one of work, codex');

    const codex = await sandbox.runCliWithInput(
      ["accounts", "set-token", "codex"],
      `${CLAUDE_TOKEN}\n`,
    );

    expect(codex.code).not.toBe(0);
    expect(codex.output).toContain("codex is a codex account");

    const empty = await sandbox.runCliWithInput(["accounts", "set-token", "work"], "\n");

    expect(empty.code).not.toBe(0);
    expect(empty.output).toContain("no token");
    expect(existsSync(join(sandbox.home, "keys/claude"))).toBe(false);
  }, 60_000);
});

describe("the answer", () => {
  test("a session that stops without its answer is sent back to send it", async () => {
    const sandbox = sandboxFor({}, { launcher: "tmux" });
    sandbox.github.addIssue("Forget the answer once", ["auto:eligible"]);
    const skip = join(sandbox.root, "skip-once");
    writeFileSync(skip, "");

    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"], {
      FAKE_CLAUDE_SKIP_ANSWER_ONCE: skip,
    });

    expect(output).toContain("done: #1:");
    expect(code).toBe(0);
    expect(sandbox.hookCalls().map((call) => call.split(" ")[2])).toEqual(["block", "allow"]);
  }, 60_000);

  test("no valid answer after three reminders hands the issue to a person", async () => {
    const sandbox = sandboxFor({}, { launcher: "tmux" });
    const issue = sandbox.github.addIssue("Never answer", ["auto:eligible"]);

    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"], {
      FAKE_CLAUDE_NEVER_ANSWER: "1",
    });

    expect(output).toContain(
      "needs-human: #1 needs a person: implement: claude: no valid answer after 3 reminders",
    );
    expect(code).toBe(0);
    expect(sandbox.github.issue(issue).labels).toContain("auto:needs-human");
    expect(sandbox.github.issue(issue).labels).not.toContain("auto:in-progress");
    expect(sandbox.hookCalls().map((call) => call.split(" ")[2])).toEqual([
      "block",
      "block",
      "block",
      "allow",
    ]);
    expect(sandbox.github.pulls.size).toBe(0);
  }, 60_000);
});

describe("doctor", () => {
  test("shows where the launcher came from, and reports a missing tmux and an unreachable Orca", async () => {
    const tmux = sandboxFor({}, { launcher: "tmux" });
    const missing = await tmux.runCli(["doctor"], { FAKE_TMUX_MISSING: "1" });
    expect(missing.output).toContain("✓ demo: launcher tmux (machine config)");
    expect(missing.output).toContain("✗ tmux: not found");
    expect(missing.output).toContain(`✗ demo: Claude trusts ${tmux.checkout}`);

    const orca = sandboxFor({}, { launcher: "orca" });
    const down = await orca.runCli(["doctor"], { FAKE_ORCA_DOWN: "1" });
    expect(down.output).toContain("✗ orca: running and reachable");

    const headless = sandboxFor();
    expect((await headless.runCli(["doctor"])).output).toContain(
      "✓ demo: runs use claude -p (launcher headless)",
    );
  }, 60_000);
});

describe("an interactive session outliving its run", () => {
  test("a rerun after the CLI is killed closes the session it left, then runs once", async () => {
    const sandbox = sandboxFor({}, { launcher: "tmux" });
    sandbox.github.addIssue("Outlive the CLI", ["auto:eligible"]);
    const hold = join(sandbox.root, "hold");
    writeFileSync(hold, "");
    const first = sandbox.cli(["run", "implement", "--repo", "demo"], { FAKE_CLAUDE_HOLD: hold });
    await waitFor(
      () => sandbox.claudeCalls().length === 1 && launchRecorded(sandbox),
      "the session to start",
    );
    process.kill(-(first.pid ?? 0), "SIGKILL");
    await closed(first);

    // The run it left ends interrupted, which puts its queue label back, so
    // the trigger offers the issue again. Its agent is still held in its
    // session, which nobody watches now.

    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);

    expect(output).toContain("as interrupted");
    expect(output).toContain("closed its tmux session");
    expect(output).toContain("done: #1:");
    expect(code).toBe(0);
    // The left session was closed before the new run started its own, so only
    // one agent worked the issue at a time; the new run closed its own as it
    // ended.
    const calls = sandbox.tmuxCalls();
    const started = calls.filter((call) => call.startsWith("new-session"));
    const killed = calls.filter((call) => call.startsWith("kill-session"));

    const nameOf = (call: string, flag: string) =>
      call.split(" ")[call.split(" ").indexOf(flag) + 1];

    expect(started).toHaveLength(2);
    expect(killed.map((call) => nameOf(call, "-t").replace(/^=/, ""))).toEqual(
      started.map((call) => nameOf(call, "-s")),
    );
    expect(calls.indexOf(killed[0] ?? "")).toBeLessThan(calls.indexOf(started[1] ?? ""));
  }, 90_000);

  test("a session the launcher wrongly says ended is waited on, not resumed into a second agent", async () => {
    const sandbox = sandboxFor({}, { launcher: "orca" });
    sandbox.github.addIssue("Outlive what Orca says", ["auto:eligible"]);
    const hold = join(sandbox.root, "hold");
    writeFileSync(hold, "");

    const run = sandbox.runCli(["run", "implement", "--repo", "demo"], {
      FAKE_CLAUDE_HOLD: hold,
      FAKE_ORCA_SAYS_ENDED: "1",
    });

    await waitFor(
      () => sandbox.claudeCalls().length === 1 && launchRecorded(sandbox),
      "the session to start",
    );
    await Bun.sleep(3000);
    rmSync(hold);
    const { code, output } = await run;
    expect(output).toContain(
      "orca says the session ended, but its process still runs; waiting on it",
    );
    expect(output).toContain("done: #1:");
    expect(code).toBe(0);
    expect(sandbox.claudeCalls()).toHaveLength(1);
    expect(sandbox.orcaCalls().filter((call) => call === "terminal create")).toHaveLength(1);
  }, 90_000);

  test("a session that dies before answering is resumed", async () => {
    const sandbox = sandboxFor({}, { launcher: "tmux" });
    sandbox.github.addIssue("Lose the session", ["auto:eligible"]);
    const hold = join(sandbox.root, "hold");
    writeFileSync(hold, "");
    const run = sandbox.runCli(["run", "implement", "--repo", "demo"], { FAKE_CLAUDE_HOLD: hold });
    await waitFor(
      () => sandbox.claudeCalls().length === 1 && existsSync(join(sandbox.root, "tmux")),
      "the session to start",
    );
    await Bun.sleep(500);
    killTmuxSession(sandbox);
    rmSync(hold);
    const { code, output } = await run;
    expect(output).toContain("resuming session");
    expect(output).toContain("done: #1:");
    expect(code).toBe(0);
    const [start = "", resume = ""] = sandbox.claudeCalls();
    expect(start).toStartWith("start ");
    expect(resume).toStartWith("resume ");
    expect(resume.split(" ")[1]).toBe(start.split(" ")[1]);
  }, 90_000);
});
