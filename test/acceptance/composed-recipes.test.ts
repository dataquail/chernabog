// Flow documents through the CLI, and the recipes' own suites on the flows their
// documents compile to.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { REVIEW_DOCUMENT, STAGES } from "../compose-harness.ts";
import { openSandbox, type Sandbox } from "./sandbox.ts";

// Its name has to be free in the sandbox's repo, whose flows include `review`.
const COMPOSED_REVIEW = REVIEW_DOCUMENT.replace("flow: review", "flow: composed-review");

describe("chernabog recipes compile", () => {
  let sandbox: Sandbox;
  const dir = () => join(sandbox.checkout, ".chernabog");
  const flow = () => join(dir(), "flows", "composed-review.ts");
  const document = () => join(dir(), "documents", "composed-review.yaml");

  beforeAll(async () => {
    sandbox = openSandbox({}, { repoFiles: { "documents/composed-review.yaml": COMPOSED_REVIEW } });
    await sandbox.installCheckout();
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("writes a document's flow file", async () => {
    const { code, output } = await sandbox.runCli(["recipes", "compile"]);

    expect(output).toContain(".chernabog/flows/composed-review.ts: written");
    expect(output).toContain("Types not checked");
    expect(code).toBe(0);
    expect(readFileSync(flow(), "utf8")).toStartWith("// Generated from the flow document");
  });

  test("--check passes on a flow file up to date, and fails on one that isn't", async () => {
    await sandbox.runCli(["recipes", "compile"]);
    const current = await sandbox.runCli(["recipes", "compile", "--check"]);
    expect(current.output).toContain("up to date");
    expect(current.code).toBe(0);

    const written = readFileSync(flow(), "utf8");
    writeFileSync(flow(), `${written}// by hand\n`);

    const stale = await sandbox.runCli(["recipes", "compile", "--check"]);
    expect(stale.output).toContain("not what its document compiles to");
    expect(stale.code).not.toBe(0);
    // It wrote nothing.
    expect(readFileSync(flow(), "utf8")).toEndWith("// by hand\n");
  });

  test("reports a problem at its line in the document, and leaves the flow file alone", async () => {
    const before = readFileSync(flow(), "utf8");
    const broken = COMPOSED_REVIEW.replace("use: pr.land", "use: pr.lands");
    writeFileSync(document(), broken);

    const line = broken.split("\n").findIndex((each) => each.includes("pr.lands")) + 1;

    const { code, output } = await sandbox.runCli(["recipes", "compile"]);

    expect(output).toContain(`.chernabog/documents/composed-review.yaml:${line}:`);
    expect(output).toContain("no block named pr.lands");
    // An agent fixing these should know more may follow.
    expect(output).toContain(
      "Types not checked: a document's wires are checked once its other problems are fixed, so compile again after fixing these.",
    );
    expect(code).not.toBe(0);
    expect(readFileSync(flow(), "utf8")).toBe(before);
  });

  test("--json gives an agent the same, to read", async () => {
    const { code, output } = await sandbox.runCli(["recipes", "compile", "--json"]);

    const said: unknown = JSON.parse(
      output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1),
    );

    expect(said).toMatchObject({
      flows: [{ flow: "composed-review", outcome: "problems" }],
      unknown: [],
    });
    expect(code).not.toBe(0);
  });

  test("says a document that doesn't parse is broken at its line, with no path to say", async () => {
    writeFileSync(document(), "flow: composed-review\nsteps: [\n  - id: a\n");

    const { code, output } = await sandbox.runCli(["recipes", "compile"]);

    expect(output).toMatch(/\.chernabog\/documents\/composed-review\.yaml:[2-4]:\d+: \S/);
    expect(code).not.toBe(0);
  });

  test("says when there are no documents, and that's no failure", async () => {
    rmSync(document());

    for (const args of [[], ["--check"]]) {
      const { code, output } = await sandbox.runCli(["recipes", "compile", ...args]);

      expect(output).toContain("no flow documents in .chernabog/documents/");
      expect(code).toBe(0);
    }
  });
});

describe("chernabog doctor, of flow documents", () => {
  let sandbox: Sandbox;
  const dir = () => join(sandbox.checkout, ".chernabog");
  const flow = () => join(dir(), "flows", "composed-review.ts");
  const document = () => join(dir(), "documents", "composed-review.yaml");

  const STALE =
    "demo: .chernabog/flows/composed-review.ts isn't what its flow document compiles to";

  // What doctor says of .chernabog/ as committed and pushed to the base branch,
  // which the daemon runs.
  const doctorOnPush = async (message: string) => {
    sandbox.git(sandbox.checkout, "add", "-A", ".");
    sandbox.git(sandbox.checkout, "commit", "-qm", message, "--allow-empty");
    sandbox.git(sandbox.checkout, "push", "-q", "origin", "main");

    return (await sandbox.runCli(["doctor"])).output;
  };

  beforeAll(async () => {
    sandbox = openSandbox({}, { repoFiles: { "documents/composed-review.yaml": COMPOSED_REVIEW } });
    writeFileSync(join(sandbox.checkout, ".gitignore"), ".chernabog/node_modules/\n");
    await sandbox.installCheckout();
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("says nothing of a flow file up to date with its document", async () => {
    await sandbox.runCli(["recipes", "compile"]);
    const said = await doctorOnPush("chore: compile composed-review");

    expect(said).toContain("demo: runs ");
    expect(said).not.toContain(STALE);
    expect(said).not.toContain("flow document has problems");
  }, 90_000);

  test("warns of a document edited and not compiled, naming the flow and the fix", async () => {
    writeFileSync(document(), COMPOSED_REVIEW.replace("concurrency: 1", "concurrency: 2"));
    const said = await doctorOnPush("chore: edit the document");

    expect(said).toContain(`! ${STALE}; the daemon runs the flow file`);
    expect(said).toContain("fix: chernabog recipes compile composed-review, or");
    // A warning: doctor passes on it.
    expect(said).not.toContain("✗ demo: .chernabog/flows");

    await sandbox.runCli(["recipes", "compile"]);
    expect(await doctorOnPush("chore: recompile")).not.toContain(STALE);
  }, 120_000);

  test("warns of a flow file edited by hand", async () => {
    writeFileSync(flow(), `${readFileSync(flow(), "utf8")}// by hand\n`);

    expect(await doctorOnPush("chore: edit the flow file")).toContain(`! ${STALE}`);
  }, 90_000);

  test("reports a document with problems as such, not as stale", async () => {
    writeFileSync(document(), COMPOSED_REVIEW.replace("use: pr.land", "use: pr.lands"));
    const said = await doctorOnPush("chore: break the document");

    expect(said).toContain("! demo: the composed-review flow document has problems");
    expect(said).toContain("no block named pr.lands");
    expect(said).not.toContain(STALE);
  }, 90_000);

  test("says nothing of a repo with no documents", async () => {
    rmSync(document());
    const said = await doctorOnPush("chore: drop the document");

    expect(said).toContain("demo: runs ");
    expect(said).not.toContain("flow document");
  }, 90_000);
});

describe("chernabog recipes blocks", () => {
  let sandbox: Sandbox;

  beforeAll(async () => {
    sandbox = openSandbox(
      {},
      {
        repoFiles: { "stages/which-pr.ts": STAGES["which-pr.ts"], "stages/notify": STAGES.notify },
      },
    );
    await sandbox.installCheckout();
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("lists what a document can use, by the SDK the repo pins", async () => {
    const { code, output } = await sandbox.runCli(["recipes", "blocks"]);

    expect(code).toBe(0);
    expect(output).toContain("A flow document is YAML");
    expect(output).toContain("Blocks:");
    expect(output).toContain("agent.implement: Has the agent implement");
    expect(output).toContain("on needs-clarification (must route)");
    expect(output).toContain("runs before: branch.push");
    expect(output).toContain("issues.queued: Open issues");
    expect(output).toContain(
      "issue: trigger gives issue, queued; or start: true, and a person starts each run with chernabog start <issue>",
    );
    expect(output).toContain("hybrid.workWithPerson: Opens a session with the person");
    expect(output).toContain("spec: trigger gives issue, queued");
    // What failureContext can keep, which only a subject's listing says.
    expect(output).toContain("chernabog start <issue>; failureContext keeps pr");
    expect(output).toContain("pull-request: trigger gives pr\n");
    expect(output).toContain(
      "  runs last: only on a run's way out, so in a repeat it takes no round, and no way past it goes on to another round",
    );
  });

  test("describes the blocks and sources named, and fails on one there isn't", async () => {
    const named = await sandbox.runCli(["recipes", "blocks", "gate.local", "issues.queued"]);

    expect(named.code).toBe(0);
    expect(named.output).toContain("gate.local: Runs the repo's local gate");
    expect(named.output).toContain("if it fails: ");
    expect(named.output).toContain("with labels: a list of eligible and ship");
    expect(named.output).not.toContain("agent.implement");

    const unknown = await sandbox.runCli(["recipes", "blocks", "gate.lint"]);

    expect(unknown.code).not.toBe(0);
    expect(unknown.output).toContain("no block, source or stage named gate.lint");
  });

  test("lists the repo's Effect stages, with what each takes and gives", async () => {
    const all = await sandbox.runCli(["recipes", "blocks"]);

    expect(all.code).toBe(0);
    expect(all.output).toContain("Stages, this repo's own:");
    expect(all.output).toContain("which-pr: .chernabog/stages/which-pr, run with stage: which-pr");
    expect(all.output).toContain("in or with pr: number");
    expect(all.output).toContain("in or with note (optional): string");
    expect(all.output).toContain("gives: pr (number)");
    expect(all.output).toContain("say under failure what each means: Skip, StepFailed");
    // A shell stage has no types to list.
    expect(all.output).not.toContain("notify:");

    const named = await sandbox.runCli(["recipes", "blocks", "which-pr", "--json"]);

    expect(named.code).toBe(0);
    expect(named.output).toContain('"stages":[{"name":"which-pr"');
    expect(named.output).not.toContain('"name":"agent.implement"');
  });

  test("--json gives an agent the catalogue to read", async () => {
    const { code, output } = await sandbox.runCli(["recipes", "blocks", "--json"]);

    expect(code).toBe(0);
    expect(output).toContain('"name":"branch.push"');
    expect(output).toContain('"gives":{"pushed":"Pushed: proof for pr.open"}');
  });

  test("--json gives only the blocks and sources named, and fails on one there isn't", async () => {
    const named = await sandbox.runCli([
      "recipes",
      "blocks",
      "gate.local",
      "issues.queued",
      "--json",
    ]);

    expect(named.code).toBe(0);
    expect(named.output).toContain('"name":"gate.local"');
    expect(named.output).toContain('"name":"issues.queued"');
    expect(named.output).not.toContain('"name":"agent.implement"');
    expect(named.output).not.toContain('"name":"review.requested"');

    const unknown = await sandbox.runCli(["recipes", "blocks", "gate.lint", "--json"]);

    expect(unknown.code).not.toBe(0);
    expect(unknown.output).toContain("no block, source or stage named gate.lint");
    expect(unknown.output).not.toContain('"name":');
  });
});

describe("the recipes' own suites", () => {
  test("pass on the flows their documents compile to", async () => {
    const child = Bun.spawn([process.execPath, "run", "test:composed"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    const said = `${out}\n${err}`;
    const passed = Number(/^\s*(\d+) pass$/m.exec(said)?.[1] ?? 0);

    expect(code).toBe(0);
    expect(passed).toBeGreaterThan(150);
  }, 300_000);
});
