// Runs the real CLI end to end against a fake GitHub (refs in a local bare
// repo) and a fake `claude`, from a repo whose .chernabog/ is the scaffold.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { BUNDLED_SDK } from "../../src/platform/flow-deps.ts";
import { closed, openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// The SDK in this checkout. A release PR bumps it before npm has it, so the
// pin resolves here rather than from the registry.
const SDK_CHECKOUT = fileURLToPath(new URL("../../packages/sdk", import.meta.url));

describe("chernabog run implement", () => {
  let sandbox: Sandbox;

  beforeAll(() => {
    sandbox = openSandbox();
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("takes a queued issue to a green pull request handed off for review", async () => {
    const issue = sandbox.github.addIssue("Do the thing", ["auto:eligible"]);
    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
    expect(output).toContain("done: #1:");
    expect(code).toBe(0);

    const { labels } = sandbox.github.issue(issue);
    expect(labels).not.toContain("auto:eligible");
    expect(labels).not.toContain("auto:in-progress");
    const pull = Option.getOrThrow(sandbox.github.firstPull());
    expect(pull.head).toBe("auto/issue-1");
    expect(pull.body).toStartWith("Closes #1");
    expect(pull.labels).toContain("auto:needs-review");
    expect(
      sandbox.github
        .commentsOn(issue)
        .map((comment) => comment.body)
        .join("\n"),
    ).toContain("Pull request ready for review");

    // Issues are often public: the claim names neither the machine nor a path on it.
    const claim =
      sandbox.github.commentsOn(issue).find((comment) => comment.body.includes("chernabog-claim"))
        ?.body ?? "";

    expect(claim).toContain("auto/issue-1");
    expect(claim).not.toContain(hostname());
    expect(claim).not.toContain(sandbox.root);
    expect(sandbox.claudeCalls()).toHaveLength(1);
    expect(
      execFileSync("git", ["--git-dir", sandbox.bare, "log", "--oneline", "auto/issue-1"], {
        encoding: "utf8",
      }),
    ).toContain("feat: change");
  }, 60_000);

  test("keeps the structured answer when a background task wakes the session after it", async () => {
    sandbox.github.addIssue("Answer, then get woken", ["auto:eligible"]);

    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"], {
      FAKE_CLAUDE_WOKEN_AFTER: "1",
    });

    expect(output).toContain("is ready for review");
    expect(code).toBe(0);
  }, 60_000);

  test("nothing queued is nothing to do", async () => {
    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
    expect(output).toContain("nothing to do");
    expect(code).toBe(0);
  }, 30_000);
});

describe("a run killed mid-agent", () => {
  let sandbox: Sandbox;

  beforeAll(() => {
    sandbox = openSandbox();
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("resumes after the last completed step, and the agent resumes its session", async () => {
    const issue = sandbox.github.addIssue("Survive a crash", ["auto:eligible"]);
    const hang = join(sandbox.root, "hang-once");
    writeFileSync(hang, "");

    const first = sandbox.cli(["run", "implement", "--repo", "demo"], {
      FAKE_CLAUDE_HANG_ONCE: hang,
    });

    await waitFor(
      () => sandbox.claudeCalls().length === 1 && !existsSync(hang),
      "the agent to start",
    );
    process.kill(-(first.pid ?? 0), "SIGKILL");
    await closed(first);

    const { code, output } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
    expect(output).toContain("resuming");
    expect(output).toContain("done: #1:");
    expect(code).toBe(0);

    const calls = sandbox.claudeCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toStartWith("start ");
    expect(calls[1]).toStartWith("resume ");
    const [start = "", resume = ""] = calls;
    expect(resume.split(" ")[1]).toBe(start.split(" ")[1]);

    // The claim ran once, before the crash, and was not repeated.
    const claims = sandbox.github
      .commentsOn(issue)
      .filter((comment) => comment.body.includes("chernabog-claim"));

    expect(claims).toHaveLength(1);
    expect(sandbox.github.pulls.size).toBe(1);
  }, 90_000);
});

describe("steps from .chernabog/stages/", () => {
  let sandbox: Sandbox;
  beforeAll(() => {
    sandbox = openSandbox();
    const stages = join(sandbox.checkout, ".chernabog/stages");
    writeFileSync(
      join(sandbox.checkout, ".chernabog/flows/custom.ts"),
      `import { defineFlow, step } from '@chernabog/sdk';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
export default defineFlow({
  trigger: Effect.succeed([{ key: 'one', data: { name: 'ada' } }, { key: 'skip', data: { name: 'skip' } }]),
  workflow: (item) =>
    Effect.gen(function* () {
      const greeting = yield* step('greet', item.data, Schema.Struct({ greeting: Schema.String, repo: Schema.String }));
      const shouted = yield* step('shout', { text: greeting.greeting }, Schema.Struct({ text: Schema.String }));
      return shouted.text + ' in ' + greeting.repo;
    }),
});
`,
    );
    writeFileSync(
      join(stages, "greet.ts"),
      `import { defineStage, Repo, Skip } from '@chernabog/sdk';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
export default defineStage({
  name: 'greet',
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.Struct({ greeting: Schema.String, repo: Schema.String }),
  run: ({ name }) =>
    Effect.gen(function* () {
      const repo = yield* Repo;
      return { greeting: 'hello ' + name, repo: repo.slug };
    }),
});
`,
    );
    writeFileSync(
      join(stages, "shout"),
      `#!/bin/sh
input=$(cat)
case "$input" in *skip*) echo "nothing to shout" >&2; exit 78;; esac
text=$(printf '%s' "$input" | sed -E 's/.*"text":"([^"]*)".*/\\1/' | tr a-z A-Z)
echo "shouting" >&2
printf '{"text":"%s"}\\n' "$text"
`,
      { mode: 0o755 },
    );
    sandbox.git(sandbox.checkout, "add", ".");
    sandbox.git(sandbox.checkout, "commit", "-qm", "feat: a custom flow");
    sandbox.git(sandbox.checkout, "push", "-q", "origin", "main");
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("an Effect step and a shell step run in their own processes and pass their output on", async () => {
    const { code, output } = await sandbox.runCli([
      "run",
      "custom",
      "--repo",
      "demo",
      "--item",
      "one",
    ]);

    expect(output).toContain("done: HELLO ADA in dataquail/demo");
    expect(output).toContain("shout: shouting");
    expect(code).toBe(0);
  }, 30_000);

  test("a step that exits 78 skips the run", async () => {
    const { code, output } = await sandbox.runCli([
      "run",
      "custom",
      "--repo",
      "demo",
      "--item",
      "skip",
    ]);

    expect(output).toContain("skipped: nothing to shout");
    expect(code).toBe(0);
  }, 30_000);
});

describe("packages from .chernabog/package.json", () => {
  let sandbox: Sandbox;

  beforeAll(() => {
    sandbox = openSandbox();
    const config = join(sandbox.checkout, ".chernabog");
    mkdirSync(join(config, "vendor/greet"), { recursive: true });
    writeFileSync(
      join(config, "vendor/greet/package.json"),
      '{ "name": "greet", "version": "1.0.0", "type": "module", "main": "index.js" }',
    );
    writeFileSync(
      join(config, "vendor/greet/index.js"),
      'export const greet = (name) => "hello " + name;\n',
    );
    writeFileSync(
      join(config, "package.json"),
      `{ "private": true, "dependencies": { "greet": "file:./vendor/greet" }, "devDependencies": { "@chernabog/sdk": "${BUNDLED_SDK}" }, "overrides": { "@chernabog/sdk": "file:${SDK_CHECKOUT}" } }`,
    );
    writeFileSync(
      join(config, "flows/greeting.ts"),
      `import { defineFlow } from '@chernabog/sdk';
import * as Effect from 'effect/Effect';
import { greet } from 'greet';
export default defineFlow({
  trigger: Effect.succeed([{ key: 'one', data: {} }]),
  workflow: () => Effect.succeed(greet('ada')),
});
`,
    );
    // The lockfile is committed; what this install leaves in the checkout is not, so only the snapshot's install can satisfy the import.
    execFileSync(process.execPath, ["install"], { cwd: config, stdio: "ignore" });
    rmSync(join(config, "node_modules"), { recursive: true });
    sandbox.git(sandbox.checkout, "add", ".");
    sandbox.git(sandbox.checkout, "commit", "-qm", "feat: a flow with a dependency");
    sandbox.git(sandbox.checkout, "push", "-q", "origin", "main");
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("a flow imports a package its .chernabog/ declares, installed into the base branch's snapshot", async () => {
    const { code, output } = await sandbox.runCli([
      "run",
      "greeting",
      "--repo",
      "demo",
      "--item",
      "one",
    ]);

    expect(output).toContain("done: hello ada");
    expect(code).toBe(0);
  }, 30_000);
});

describe("a loop cap", () => {
  let sandbox: Sandbox;

  beforeAll(() => {
    sandbox = openSandbox({ localGate: ["false"], limits: { localGateRounds: 1 } });
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("hands the issue to a person, and the run ends needs-human", async () => {
    const issue = sandbox.github.addIssue("Never passes", ["auto:eligible"]);
    const { output } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);
    expect(output).toContain(
      "needs-human: #1 needs a person: the local gate still fails after 1 fix attempts",
    );
    expect(sandbox.github.issue(issue).labels).toContain("auto:needs-human");
    expect(sandbox.github.issue(issue).labels).not.toContain("auto:in-progress");
    expect(sandbox.github.pulls.size).toBe(0);
    expect(sandbox.claudeCalls()).toHaveLength(2);
  }, 60_000);
});
