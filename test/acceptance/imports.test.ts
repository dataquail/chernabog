// Flows imported from a recipe package, end to end: imported with
// `recipes add --import`, a flow with no file in flows/ runs from the
// snapshot's node_modules under the binary's SDK, with the package's prompt
// unless the repo overrides it; doctor says where it comes from; a package
// written for another SDK is refused, naming it; and eject turns the flow
// into the repo's own, under the same name.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { ACME_TOKEN } from "./fake-registry.ts";
import { openSandbox, type Sandbox } from "./sandbox.ts";

describe("imported flows", () => {
  let sandbox: Sandbox;
  const dir = () => join(sandbox.checkout, ".chernabog");

  // bun in .chernabog/, as a person runs it there; never synchronously, as
  // this process serves the registry it installs from.
  const bun = async (...args: ReadonlyArray<string>) => {
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: dir(),
      env: sandbox.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    if ((await child.exited) !== 0) {
      throw new Error(`bun ${args.join(" ")}: ${await new Response(child.stderr).text()}`);
    }
  };

  // .chernabog/ as committed and pushed to the base branch, which runs read.
  const push = (message: string) => {
    sandbox.git(sandbox.checkout, "add", ".");
    sandbox.git(sandbox.checkout, "commit", "-qm", message);
    sandbox.git(sandbox.checkout, "push", "-q", "origin", "main");
  };

  const run = () => sandbox.runCli(["run", "implement", "--repo", "demo"]);

  beforeAll(() => {
    sandbox = openSandbox({}, { recipes: [], flows: { implement: {} } });
    writeFileSync(join(sandbox.checkout, ".gitignore"), ".chernabog/node_modules/\n");
    const host = new URL(sandbox.registry.url).host;
    writeFileSync(
      join(dir(), ".npmrc"),
      `@acme:registry=${sandbox.registry.url}\n//${host}/:_authToken=${ACME_TOKEN}\n`,
    );
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("recipes add --import writes the from and moves the package to dependencies, copying nothing", async () => {
    await bun("add", "--dev", "--exact", "@chernabog/recipes@0.2.0");
    const { code, output } = await sandbox.runCli(["recipes", "add", "--import", "implement"]);

    expect(code).toBe(0);
    expect(output).toContain(
      "imported implement from the implement recipe, 0.2.0 (flows.implement.from in .chernabog/config.yaml)",
    );
    expect(output).toContain(
      ".chernabog/package.json: @chernabog/recipes in dependencies, which a snapshot installs",
    );
    expect(readFileSync(join(dir(), "config.yaml"), "utf8")).toContain(
      'from: "@chernabog/recipes/implement"',
    );
    expect(existsSync(join(dir(), "flows"))).toBe(false);
    expect(existsSync(join(dir(), "prompts"))).toBe(false);
    expect((await sandbox.runCli(["recipes", "list"])).output).toContain("→ implement:");
    push("chore: import implement");
  }, 60_000);

  test("the imported flow runs from the snapshot's node_modules, with the package's prompt", async () => {
    sandbox.github.addIssue("Do it from the package", ["auto:eligible"]);
    const { code, output } = await run();

    expect(output).toContain("done: #1:");
    expect(code).toBe(0);
    expect(sandbox.claudeCalls().at(-1)).toContain("# Implement issue #1 in dataquail/demo");

    const doctor = (await sandbox.runCli(["doctor"])).output;
    expect(doctor).toContain("demo: runs implement · @chernabog/recipes@0.2.0");
  }, 90_000);

  test("a prompt of the repo's own overrides the package's", async () => {
    await Bun.write(join(dir(), "prompts", "implement.md"), "# Our own take on #{{issue}}\n");
    push("chore: our implement prompt");
    sandbox.github.addIssue("Do it our way", ["auto:eligible"]);
    const { code } = await run();

    expect(code).toBe(0);
    expect(sandbox.claudeCalls().at(-1)).toContain("# Our own take on #");
  }, 90_000);

  test("a flow with both a from and a file in flows/ is refused", async () => {
    await Bun.write(join(dir(), "flows", "implement.ts"), "export default {};\n");

    const { code, output } = await sandbox.runCli([
      "run",
      "implement",
      "--repo",
      "demo",
      "--from-checkout",
    ]);

    expect(code).not.toBe(0);
    expect(output).toContain(
      "flows.implement in config.yaml imports @chernabog/recipes/implement, and flows/implement.ts is a flow of the same name",
    );
    await Bun.file(join(dir(), "flows", "implement.ts")).delete();
  }, 60_000);

  test("a package written for an SDK this binary doesn't run is refused, naming it", async () => {
    await bun("add", "--exact", "@acme/recipes@2.0.0");
    expect(
      (await sandbox.runCli(["recipes", "add", "--import", "@acme/recipes/deploy"])).code,
    ).toBe(0);
    push("chore: import deploy");

    const doctor = (await sandbox.runCli(["doctor"])).output;
    expect(doctor).toContain(
      "demo: incompatible: .chernabog/: config.yaml imports flows from @acme/recipes 2.0.0, which supports @chernabog/sdk ^0.5.0",
    );

    const { code, output } = await run();
    expect(code).not.toBe(0);
    expect(output).toContain("@acme/recipes 2.0.0");

    // Back to a version that supports it.
    await bun("add", "--exact", "@acme/recipes@1.0.0");
    push("chore: acme recipes 1.0.0");
    const fixed = (await sandbox.runCli(["doctor"])).output;
    expect(fixed).not.toContain("incompatible");
    expect(fixed).toContain("demo: .chernabog/ is written against an SDK this chernabog runs");
  }, 90_000);

  test("eject copies the imported flow in, and it keeps running under the same name and settings", async () => {
    const { code, output } = await sandbox.runCli(["recipes", "eject", "implement"]);

    expect(code).toBe(0);
    expect(output).toContain("wrote .chernabog/flows/implement.ts (implement recipe, 0.2.0)");
    expect(output).toContain(
      "kept .chernabog/prompts/implement.md, which the repo has already and which overrode the package's",
    );
    expect(readFileSync(join(dir(), "config.yaml"), "utf8")).not.toContain(
      "@chernabog/recipes/implement",
    );
    push("chore: eject implement");

    sandbox.github.addIssue("Do it from our copy", ["auto:eligible"]);
    const ran = await run();
    expect(ran.code).toBe(0);
    expect(ran.output).toContain("is ready for review");

    const doctor = (await sandbox.runCli(["doctor"])).output;
    expect(doctor).toContain("demo: runs implement\n");
    expect((await sandbox.runCli(["recipes", "diff", "implement"])).output).toContain(
      ".chernabog/flows/implement.ts: the same as the implement recipe in @chernabog/recipes@0.2.0",
    );
  }, 90_000);
});
