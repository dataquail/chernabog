// Flow documents through the CLI, and the recipes' own suites on the flows their
// documents compile to.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { REVIEW_DOCUMENT } from "../compose-harness.ts";
import { openSandbox, type Sandbox } from "./sandbox.ts";

describe("chernabog recipes compile", () => {
  let sandbox: Sandbox;
  const dir = () => join(sandbox.checkout, ".chernabog");
  const flow = () => join(dir(), "flows", "composed-review.ts");
  const document = () => join(dir(), "documents", "composed-review.yaml");

  beforeAll(async () => {
    sandbox = openSandbox({}, { repoFiles: { "documents/composed-review.yaml": REVIEW_DOCUMENT } });
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
    const broken = REVIEW_DOCUMENT.replace("use: pr.land", "use: pr.lands");
    writeFileSync(document(), broken);

    const line = broken.split("\n").findIndex((each) => each.includes("pr.lands")) + 1;

    const { code, output } = await sandbox.runCli(["recipes", "compile"]);

    expect(output).toContain(`.chernabog/documents/composed-review.yaml:${line}:`);
    expect(output).toContain("no block named pr.lands");
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
