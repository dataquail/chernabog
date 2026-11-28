// The implement flow on each agent, end to end, with fake CLIs that print the real event shapes.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { closed, openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

const sandboxes: Array<Sandbox> = [];

const sandboxFor = (...args: Parameters<typeof openSandbox>) => {
  const sandbox = openSandbox(...args);
  sandboxes.push(sandbox);

  return sandbox;
};

afterAll(async () => {
  await Promise.all(sandboxes.map((sandbox) => sandbox.github.stop()));
});

describe("implement on Codex", () => {
  test("a repo whose account is a Codex account runs implement on Codex", async () => {
    const sandbox = sandboxFor({}, { account: "codex" });
    sandbox.github.addIssue("Do it with Codex", ["auto:eligible"]);
    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
    expect(output).toContain("codex: starting a thread");
    expect(output).toContain('$ bash -lc "git commit"');
    expect(output).toContain("done: #1:");
    expect(code).toBe(0);
    expect(Option.getOrThrow(sandbox.github.firstPull()).title).toBe(
      "feat: do the thing with codex",
    );
    expect(sandbox.claudeCalls()).toHaveLength(0);
    const [call] = sandbox.codexCalls();
    expect(call).toContain("--approve-for-me");
    expect(call).toContain('sandbox_mode=\\"workspace-write\\"');
    expect(call).toContain("--output-schema");
  }, 60_000);

  test("a run killed mid-agent ends interrupted, and its phase repeats in a new run", async () => {
    const sandbox = sandboxFor({}, { account: "codex" });
    sandbox.github.addIssue("Survive a crash on Codex", ["auto:eligible"]);
    const hang = join(sandbox.root, "hang-once");
    writeFileSync(hang, "");

    const first = sandbox.cli(["run", "implement", "--repo", "demo"], {
      FAKE_AGENT_HANG_ONCE: hang,
    });

    await waitFor(() => sandbox.codexCalls().length === 1 && !existsSync(hang), "codex to start");

    // Killed only once chernabog has kept the thread Codex started, as it
    // does on thread.started; a fixed wait lost that race on a loaded machine.
    const thread = (sandbox.codexCalls()[0] ?? "").split(" ")[1] ?? "";
    const links = join(sandbox.home, "sessions", "codex");

    await waitFor(
      () =>
        existsSync(links) &&
        readdirSync(links).some((link) => readFileSync(join(links, link), "utf8").includes(thread)),
      "chernabog to keep the Codex thread",
    );
    process.kill(-(first.pid ?? 0), "SIGKILL");
    await closed(first);
    // The run it left ends interrupted, which puts its queue label back, so
    // the trigger offers the issue again.
    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
    expect(output).toContain("as interrupted");
    expect(code).toBe(0);
    // Nothing resumes a run from its journal (ADR 23, decision 3): the new
    // run starts its agent call again.
    const [initial = "", again = ""] = sandbox.codexCalls();
    expect(initial).toStartWith("start ");
    expect(again).toStartWith("start ");
    expect(output).toContain("done: #1:");
  }, 90_000);
});

// What fakebin's runtime records of a `run`: its arguments.
const RunArgs = Schema.fromJsonString(Schema.Array(Schema.String));

// What fakebin/codex logs of what it was signed in with.
const CodexEnv = Schema.fromJsonString(
  Schema.Struct({
    codexHome: Schema.optionalKey(Schema.String),
    login: Schema.optionalKey(Schema.String),
    env: Schema.Array(Schema.String),
  }),
);

// What the host's login holds once a session refreshed it.
const KeptLogin = Schema.fromJsonString(
  Schema.Struct({
    tokens: Schema.Struct({ access_token: Schema.String, account_id: Schema.String }),
  }),
);

// A ChatGPT login as `codex login` keeps it in $CODEX_HOME/auth.json.
const CODEX_LOGIN = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    id_token: "id-token",
    access_token: "codex-access-token",
    refresh_token: "codex-refresh-token",
    account_id: "acct-1",
  },
  last_refresh: "2026-11-01T00:00:00Z",
});

// What a sandboxed Codex session's env may hold (ADR 24, decision 7): its
// own CODEX_HOME and the account's login, the persona's GH_TOKEN and the git
// config that answers github.com with it, and who commits are by.
const SANDBOXED_CODEX_VARIABLE =
  /^(CODEX_HOME|CHERNABOG_CODEX_LOGIN|GH_TOKEN|GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL))$/;

// ADR 24, decision 4: Codex runs headless in the repo's container, with its
// own workspace sandbox off, since the container is the sandbox.
describe.each(["docker", "podman"] as const)("implement on Codex in a %s sandbox", (provider) => {
  const runtimeEnv = (sandbox: Sandbox) => ({
    FAKE_RUNTIME_LOG: join(sandbox.root, "runtime.log"),
    FAKE_RUNTIME_STATE: join(sandbox.root, "runtime"),
    FAKE_CODEX_ENV_LOG: join(sandbox.root, "codex-env.log"),
  });

  const runs = (sandbox: Sandbox) => {
    const log = join(sandbox.root, "runtime.log");

    if (!existsSync(log)) {
      return [];
    }

    return (
      readFileSync(log, "utf8")
        .split("\n")
        // The session's container; the install and local gate run in their own (#722).
        .filter(
          (call) => call.startsWith(`${provider} run `) && call.includes('"chernabog.session='),
        )
        .map((call) => Schema.decodeSync(RunArgs)(call.slice(`${provider} run `.length)))
    );
  };

  const signIn = (sandbox: Sandbox, login = CODEX_LOGIN) => {
    mkdirSync(join(sandbox.root, "codex"), { recursive: true });
    writeFileSync(join(sandbox.root, "codex", "auth.json"), login);
  };

  test("completes the session in the container, signed in only through its env", async () => {
    const sandbox = sandboxFor(
      { sandbox: provider },
      { account: "codex", github: ["alice"], personas: ["alice"] },
    );

    sandbox.github.addIssue("Do it with Codex", ["auto:eligible"]);
    signIn(sandbox);

    const { code, output } = await sandbox.runCli(
      ["run", "implement", "--repo", "demo", "--as", "alice"],
      {
        ...runtimeEnv(sandbox),
        // A host's own credentials, none of which reach the container.
        OPENAI_API_KEY: "host-openai-key",
        AWS_SECRET_ACCESS_KEY: "host-aws-secret",
      },
    );

    expect(output).toContain("done: #1:");
    expect(code).toBe(0);
    expect(Option.getOrThrow(sandbox.github.firstPull()).title).toBe(
      "feat: do the thing with codex",
    );

    const [args = [], ...others] = runs(sandbox);

    expect(others).toEqual([]);
    expect(args.slice(0, 3)).toEqual(["-i", "--rm", "--init"]);
    // In the repo's own image, built from its .chernabog/sandbox/Dockerfile.
    const image = args.findIndex((arg) => arg.startsWith("chernabog-sandbox/dataquail-demo:"));

    expect(image).toBeGreaterThan(0);
    expect(args.slice(image + 1, -1)).toContain("codex");
    expect(args.some((arg) => /^chernabog\.run=[\da-f-]+$/.test(arg))).toBe(true);
    expect(args.some((arg) => arg.startsWith("chernabog.session="))).toBe(true);

    // Codex's own sandbox is off in the container.
    const [call = ""] = sandbox.codexCalls();

    expect(call).toContain('sandbox_mode=\\"danger-full-access\\"');
    expect(call).not.toContain("workspace-write");

    // Each volume at its host path: the worktree, the repo's common git dir,
    // and of the home only the session's own CODEX_HOME and its call's files.
    const volumes = args.filter((_, at) => args[at - 1] === "--volume");
    const paths = volumes.map((volume) => volume.split(":")[0] ?? "");

    for (const volume of volumes) {
      const [from, to] = volume.split(":");

      expect(to).toBe(from);
    }

    expect(paths).toContain(realpathSync(join(sandbox.checkout, ".git")));

    const [signedIn] = readFileSync(join(sandbox.root, "codex-env.log"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => Schema.decodeSync(CodexEnv)(line));

    const codexHome = signedIn.codexHome ?? "";

    expect(codexHome).toStartWith(join(sandbox.home, "sessions/interactive/"));
    expect(codexHome).toEndWith("/codex");
    const worktree = args[args.indexOf("--workdir") + 1] ?? "";
    const sessionDir = codexHome.slice(0, -"/codex".length);

    expect(paths).toContain(worktree);
    expect(
      paths.filter(
        (path) =>
          path.startsWith(sandbox.home) && path !== worktree && !path.startsWith(`${sessionDir}/`),
      ),
    ).toEqual([]);
    expect(paths).toContain(codexHome);
    expect(paths).not.toContain(join(sandbox.root, "codex"));

    // Signed in with the account's login, handed over by name in the env and
    // written into the session's own CODEX_HOME, never on a command line.
    expect(signedIn.login).toBe(CODEX_LOGIN);
    expect(args.join(" ")).not.toContain("codex-access-token");
    expect(args.join(" ")).not.toContain("token-alice");

    const named = args.filter((_, at) => args[at - 1] === "--env");

    expect(named.filter((name) => !SANDBOXED_CODEX_VARIABLE.test(name))).toEqual([]);
    expect(named).toContain("GH_TOKEN");
    expect(named).toContain("CHERNABOG_CODEX_LOGIN");
    expect(signedIn.env).not.toContain("CHERNABOG_CODEX_LOGIN");
    expect(sandbox.agentTokens()).toContain("codex token-alice");

    // The login isn't left in the session's CODEX_HOME once the call ends.
    expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
    // What the call spent is read from the session's own CODEX_HOME.
    expect(output).not.toContain("codex usage:");
  }, 60_000);

  test("keeps a login Codex refreshed in the container on the host", async () => {
    const sandbox = sandboxFor({ sandbox: provider }, { account: "codex" });
    sandbox.github.addIssue("Do it with Codex", ["auto:eligible"]);
    signIn(sandbox);

    const { code } = await sandbox.runCli(["run", "implement", "--repo", "demo"], {
      ...runtimeEnv(sandbox),
      FAKE_CODEX_REFRESH: "1",
    });

    expect(code).toBe(0);

    const kept = Schema.decodeSync(KeptLogin)(
      readFileSync(join(sandbox.root, "codex", "auth.json"), "utf8"),
    );

    expect(kept.tokens.access_token).toBe("refreshed");
    expect(kept.tokens.account_id).toBe("acct-1");
  }, 60_000);

  test("refuses the session when the account has no Codex login, saying how to make one", async () => {
    const sandbox = sandboxFor({ sandbox: provider }, { account: "codex" });
    sandbox.github.addIssue("Do it with Codex", ["auto:eligible"]);

    const { output } = await sandbox.runCli(
      ["run", "implement", "--repo", "demo"],
      runtimeEnv(sandbox),
    );

    expect(output).toContain("account codex has no Codex login");
    expect(output).toContain("codex login");
    expect(sandbox.codexCalls()).toHaveLength(0);
    expect(runs(sandbox)).toEqual([]);
  }, 60_000);
});

describe("implement on opencode", () => {
  test("the answer format goes into the prompt, and the answer comes from the last message", async () => {
    const sandbox = sandboxFor({ agent: "opencode" });
    sandbox.github.addIssue("Do it with opencode", ["auto:eligible"]);
    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
    expect(output).toContain("done: #1:");
    expect(code).toBe(0);
    expect(sandbox.opencodeCalls()[0]).toEndWith("with-format");
    expect(Option.getOrThrow(sandbox.github.firstPull()).title).toBe("feat: opencode");
  }, 60_000);
});

describe("a custom agent from machine config", () => {
  test("runs its command template and reads the last JSON it prints", async () => {
    const script = `cd "$1" && n=$(git rev-list --count HEAD) && echo x > change-$n.txt && git add . && git -c user.name=F -c user.email=f@x commit -qm "feat: custom" && echo '{"status":"done","summary":"s","title":"feat: custom","body":"b"}'`;

    const sandbox = sandboxFor(
      { agent: "mine" },
      { agents: { mine: { start: ["sh", "-c", script, "sh", "{cwd}"] } } },
    );

    sandbox.github.addIssue("Do it my way", ["auto:eligible"]);
    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
    expect(output).toContain("done: #1:");
    expect(code).toBe(0);
  }, 60_000);
});
