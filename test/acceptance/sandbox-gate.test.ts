// A sandboxed repo's install and local gate run in a container from its image
// (ADR 24, decision 10), with the worktree and the common git dir mounted as
// for a session and none of the agent's or persona's credentials; an
// unsandboxed repo's run on the host, as before.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";

import { openSandbox, type Sandbox } from "./sandbox.ts";

const sandboxes: Array<Sandbox> = [];

const sandboxFor = (...args: Parameters<typeof openSandbox>) => {
  const sandbox = openSandbox(...args);
  sandboxes.push(sandbox);

  return sandbox;
};

afterAll(async () => {
  await Promise.all(sandboxes.map((sandbox) => sandbox.github.stop()));
});

// What fakebin's runtime records of a `run`: its arguments.
const RunArgs = Schema.fromJsonString(Schema.Array(Schema.String));

// A ChatGPT login as `codex login` keeps it, for the Codex session (a
// sandboxed Claude session needs a launcher; Codex's runs headless).
const CODEX_LOGIN = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: { access_token: "codex-access-token", account_id: "acct-1" },
  last_refresh: "2026-11-01T00:00:00Z",
});

const INSTALL = 'echo installed >> "$FAKE_GATE_LOG"';
const GATE = 'env >> "$FAKE_GATE_LOG"; test -n "$(ls change-*.txt)"';

const settings = { install: INSTALL, localGate: [GATE] };

const gateLog = (sandbox: Sandbox) => join(sandbox.root, "gate.log");

const runtimeEnv = (sandbox: Sandbox) => ({
  FAKE_RUNTIME_LOG: join(sandbox.root, "runtime.log"),
  FAKE_RUNTIME_STATE: join(sandbox.root, "runtime"),
  FAKE_GATE_LOG: gateLog(sandbox),
  // A host credential no command of a sandboxed repo is given.
  GITHUB_TOKEN: "host-github-token",
});

const runs = (sandbox: Sandbox, provider: string) => {
  const log = join(sandbox.root, "runtime.log");

  if (!existsSync(log)) {
    return [];
  }

  return readFileSync(log, "utf8")
    .split("\n")
    .filter((call) => call.startsWith(`${provider} run `))
    .map((call) => Schema.decodeSync(RunArgs)(call.slice(`${provider} run `.length)));
};

const valuesOf = (args: ReadonlyArray<string>, flag: string) =>
  args.filter((_, at) => args[at - 1] === flag);

describe.each(["docker", "podman"] as const)("a repo sandboxed in %s", (provider) => {
  test("runs its install and local gate in its image, with no credential", async () => {
    const sandbox = sandboxFor(
      { sandbox: provider, settings },
      { account: "codex", github: ["alice"], personas: ["alice"] },
    );

    sandbox.github.addIssue("Gate it in the container", ["auto:eligible"]);
    mkdirSync(join(sandbox.root, "codex"), { recursive: true });
    writeFileSync(join(sandbox.root, "codex", "auth.json"), CODEX_LOGIN);

    const { code, output } = await sandbox.runCli(
      ["run", "implement", "--repo", "demo", "--as", "alice"],
      runtimeEnv(sandbox),
    );

    expect(output).toContain("done: #1:");
    expect(code).toBe(0);

    const commands = runs(sandbox, provider).filter(
      (args) => args.at(-3) === "sh" && args.at(-2) === "-c",
    );

    expect(commands.map((args) => args.at(-1))).toEqual([INSTALL, GATE]);

    const common = realpathSync(join(sandbox.checkout, ".git"));

    for (const args of commands) {
      expect(args.slice(0, 3)).toEqual(["-i", "--rm", "--init"]);
      expect(args.at(-4)).toStartWith("chernabog-sandbox/dataquail-demo:");
      expect(
        valuesOf(args, "--label").some((label) => /^chernabog\.run=[\da-f-]+$/.test(label)),
      ).toBe(true);

      // Only the worktree and the repo's common git dir, at their host paths.
      const worktree = valuesOf(args, "--workdir")[0] ?? "";
      const paths = valuesOf(args, "--volume").map((volume) => volume.split(":")[0] ?? "");

      expect(paths.filter((path) => path !== worktree && !path.startsWith(common))).toEqual([]);

      // Nothing of the agent's or the persona's sign-in, nor the host's.
      const named = valuesOf(args, "--env");

      expect(named).toContain("CI");
      expect(named.filter((name) => /TOKEN|LOGIN|GIT_CONFIG|^PATH$|^HOME$/.test(name))).toEqual([]);
    }

    // The gate ran, in the container's environment.
    const ran = readFileSync(gateLog(sandbox), "utf8");

    expect(ran).toContain("installed");
    expect(ran).toContain("CI=1");
    expect(ran).not.toContain("token-alice");
    expect(ran).not.toContain("host-github-token");
  }, 60_000);
});

describe("an unsandboxed repo", () => {
  test("runs its install and local gate on the host, as before", async () => {
    const sandbox = sandboxFor({ settings }, { account: "codex" });
    sandbox.github.addIssue("Gate it on the host", ["auto:eligible"]);

    const { code, output } = await sandbox.runCli(
      ["run", "implement", "--repo", "demo"],
      runtimeEnv(sandbox),
    );

    expect(output).toContain("done: #1:");
    expect(code).toBe(0);
    expect(runs(sandbox, "docker")).toEqual([]);
    const ran = readFileSync(gateLog(sandbox), "utf8");

    expect(ran).toContain("installed");
    // The host's own environment, which a sandboxed repo's commands don't get.
    expect(ran).toContain("host-github-token");
  }, 60_000);
});
