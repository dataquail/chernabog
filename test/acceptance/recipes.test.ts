// Recipes through the CLI: init bakes only the ones chosen, none without a
// choice, and a set-up repo adds more later and diffs its flows against them.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { BUNDLED_SDK } from "../../src/platform/flow-deps.ts";
import { RECIPE_FILES } from "../../src/platform/templates.ts";
import { openSandbox, type Sandbox } from "./sandbox.ts";

describe("recipes", () => {
  let sandbox: Sandbox;
  const flow = (name: string) => join(sandbox.checkout, ".chernabog", "flows", `${name}.ts`);

  beforeAll(() => {
    sandbox = openSandbox({}, { recipes: [] });
    // An origin that reads as github.com/dataquail/demo, so init knows the repo.
    sandbox.git(
      sandbox.checkout,
      "remote",
      "set-url",
      "origin",
      join(sandbox.root, "github.com", "dataquail", "demo.git"),
    );
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("init without a choice bakes none, and enrolls nothing until the repo has a flow", async () => {
    const { output } = await sandbox.runCli(["init"]);
    expect(output).not.toContain("wrote .chernabog/");
    expect(output).toContain(
      "Not enrolled: .chernabog/flows/ has no flows. Add recipes with chernabog recipes add",
    );
    expect(existsSync(join(sandbox.checkout, ".chernabog", "flows"))).toBe(false);
  }, 30_000);

  test("recipes list names each, with its description and docs page", async () => {
    const { output } = await sandbox.runCli(["recipes", "list"]);
    expect(output).toContain("  human-initiated: The hybrid path");
    expect(output).toContain("    https://dataquail.github.io/chernabog/recipes/human-initiated/");
    expect(output).toContain(
      "  resolve-conflicts: Merges the base into the persona's own pull request",
    );
  }, 30_000);

  test("init --recipes bakes the ones named, as the full flow, and enrolls the repo with them", async () => {
    const { output } = await sandbox.runCli([
      "init",
      "--recipes",
      "implement,review",
      "--defaults",
    ]);

    expect(output).toContain("wrote .chernabog/flows/implement.ts (implement recipe)");
    expect(output).toContain("wrote .chernabog/prompts/review.md (review recipe)");
    expect(output).toContain("demo as this machine: flows implement, review");
    expect(readFileSync(flow("review"), "utf8")).toBe(RECIPE_FILES["flows/review.ts"]);
    expect(existsSync(flow("re-review"))).toBe(false);
  }, 30_000);

  test("recipes add bakes more later, and never overwrites a flow the repo has", async () => {
    const added = await sandbox.runCli(["recipes", "add", "human-initiated", "review"]);
    expect(added.output).toContain(
      "wrote .chernabog/flows/human-initiated.ts (human-initiated recipe)",
    );
    expect(added.output).toContain("kept .chernabog/flows/review.ts, which is already there");

    const listed = await sandbox.runCli(["recipes", "list"]);
    expect(listed.output).toContain("✓ human-initiated");
    expect(listed.output).toContain("  re-review");

    const conflicts = await sandbox.runCli(["recipes", "add", "resolve-conflicts"]);
    expect(conflicts.output).toContain(
      "wrote .chernabog/flows/resolve-conflicts.ts (resolve-conflicts recipe)",
    );
    expect(conflicts.output).toContain(
      "wrote .chernabog/prompts/resolve-conflicts.md (resolve-conflicts recipe)",
    );
    expect(readFileSync(flow("resolve-conflicts"), "utf8")).toBe(
      RECIPE_FILES["flows/resolve-conflicts.ts"],
    );

    const refused = await sandbox.runCli(["recipes", "add", "ship"]);
    expect(refused.output).toContain("no recipe named ship");
  }, 30_000);

  test("recipes diff shows how the repo's flows differ from the current recipes", async () => {
    writeFileSync(
      flow("implement"),
      RECIPE_FILES["flows/implement.ts"].replace("concurrency: 1,", "concurrency: 3,"),
    );
    const { code, output } = await sandbox.runCli(["recipes", "diff"]);
    expect(code).toBe(0);
    expect(output).toContain("Against the recipes of chernabog ");
    expect(output).toContain(
      ".chernabog/flows/implement.ts: differs from the implement recipe (https://dataquail.github.io/chernabog/recipes/implement/)",
    );
    expect(output).toContain("-  concurrency: 1,\n+  concurrency: 3,");
    expect(output).toContain(".chernabog/flows/review.ts: the same as the review recipe");
    expect(output).toContain(
      ".chernabog/flows/human-initiated.ts: the same as the human-initiated recipe",
    );
  }, 30_000);

  test("recipes upgrade moves a repo on an older SDK to one this binary loads, listing what it can't", async () => {
    const dir = join(sandbox.checkout, ".chernabog");

    // What doctor says of the repo's .chernabog/, as committed to its base branch.
    const compatible = async () => {
      sandbox.git(sandbox.checkout, "add", ".");
      sandbox.git(sandbox.checkout, "commit", "-qm", "chore: change .chernabog/");
      // As pushed: this origin is only a name, so its ref is moved here.
      sandbox.git(sandbox.checkout, "update-ref", "refs/remotes/origin/main", "HEAD");

      return (await sandbox.runCli(["doctor"])).output;
    };

    writeFileSync(
      join(dir, "package.json"),
      '{ "private": true, "engines": { "chernabog": ">=0.7.0" }, "devDependencies": { "@chernabog/sdk": "0.5.0", "effect": "4.0.0" } }\n',
    );
    writeFileSync(
      flow("review"),
      'import { defineFlow, Review } from "@chernabog/sdk";\nexport default defineFlow({ trigger: Review.fixTrigger, workflow: Review.labelVerdict });\n',
    );
    writeFileSync(
      flow("security"),
      'import { defineFlow, Review } from "@chernabog/sdk";\nexport default defineFlow({ trigger: Review.fixTrigger, workflow: () => undefined });\n',
    );
    expect(await compatible()).toContain(
      "demo: incompatible: .chernabog/: package.json still has engines.chernabog",
    );

    const { code, output } = await sandbox.runCli(["recipes", "upgrade"]);
    expect(code).toBe(0);
    expect(output).toContain(`.chernabog/package.json: pins @chernabog/sdk ${BUNDLED_SDK}`);
    expect(output).toContain(
      ".chernabog/flows/review.ts: replaced by the current review recipe; review the diff",
    );
    expect(output).toContain(
      ".chernabog/flows/implement.ts: replaced by the current implement recipe",
    );
    expect(output).toContain(
      `.chernabog/flows/security.ts: from no recipe, left as it is; it imports what @chernabog/sdk ${BUNDLED_SDK} doesn't have (Review.fixTrigger), so move it by hand`,
    );
    expect(output).toContain("Nothing is committed.");
    expect(readFileSync(flow("review"), "utf8")).toBe(RECIPE_FILES["flows/review.ts"]);
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))).not.toHaveProperty(
      "engines",
    );
    expect(await compatible()).toContain("demo: incompatible: .chernabog/: flows import what");

    // The hand-written flow, moved by hand.
    writeFileSync(flow("security"), RECIPE_FILES["flows/review.ts"]);
    expect(await compatible()).toContain(
      "demo: .chernabog/ is written against an SDK this chernabog runs",
    );
  }, 60_000);
});
