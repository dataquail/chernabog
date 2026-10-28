// Recipes through the CLI, installed by bun from a registry: init adds
// @chernabog/recipes and copies only the recipes chosen, none without a
// choice; a set-up repo adds more later, from a company's own package behind
// its .npmrc too, diffs its flows against the versions they came from, and
// updates them, merging upstream changes into its edits.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Result from "effect/Result";

import { decodeRepoManifest } from "../../src/modules/recipes/domain/recipe/repo-manifest.value-object.ts";
import { RELEASED_SDK } from "../../src/platform/flow-deps.ts";
import { ACME_DEPLOY, ACME_TOKEN, UPSTREAM_FIX } from "./fake-registry.ts";
import { openSandbox, recipeFiles, type Sandbox } from "./sandbox.ts";

describe("recipes", () => {
  let sandbox: Sandbox;
  const dir = () => join(sandbox.checkout, ".chernabog");
  const flow = (name: string) => join(dir(), "flows", `${name}.ts`);

  const manifest = () =>
    Result.getOrThrow(decodeRepoManifest(readFileSync(join(dir(), "package.json"), "utf8")));

  const copied = (file: string) => manifest().chernabog?.copied?.[file];

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

  test("init adds @chernabog/recipes at the newest version for the repo's SDK, copies none without a choice, and enrolls nothing until the repo has a flow", async () => {
    const { output } = await sandbox.runCli(["init"]);
    expect(output).toContain("added @chernabog/recipes 0.2.0 to .chernabog/package.json");
    expect(output).not.toContain("wrote .chernabog/flows");
    expect(output).toContain(
      "Not enrolled: .chernabog/flows/ has no flows. Add recipes with chernabog recipes add",
    );
    expect(manifest().devDependencies?.["@chernabog/recipes"]).toBe("0.2.0");
    expect(existsSync(join(dir(), "node_modules/@chernabog/recipes/flows/review.ts"))).toBe(true);
    expect(existsSync(join(dir(), "flows"))).toBe(false);

    // As a repo set up before 0.2.0 was released.
    await bun("add", "--dev", "--exact", "@chernabog/recipes@0.1.0");
  }, 60_000);

  test("recipes list names each recipe of each installed package, with its description and docs page", async () => {
    const { output } = await sandbox.runCli(["recipes", "list"]);
    expect(output).toContain("@chernabog/recipes 0.1.0:");
    expect(output).toContain("  human-initiated: The hybrid path");
    expect(output).toContain("    https://dataquail.github.io/chernabog/recipes/human-initiated/");
    expect(output).toContain(
      "  resolve-conflicts: Merges the base into the persona's own pull request",
    );
  }, 30_000);

  test("init --recipes copies the ones named, records the version each came from, and enrolls the repo with them", async () => {
    const { output } = await sandbox.runCli([
      "init",
      "--recipes",
      "implement,review",
      "--defaults",
    ]);

    expect(output).toContain("wrote .chernabog/flows/implement.ts (implement recipe, 0.1.0)");
    expect(output).toContain("wrote .chernabog/prompts/review.md (review recipe, 0.1.0)");
    expect(output).toContain("demo as this machine: flows implement, review");
    expect(readFileSync(flow("review"), "utf8")).toBe(recipeFiles(["review"])["flows/review.ts"]);
    expect(existsSync(flow("re-review"))).toBe(false);
    expect(copied("flows/implement.ts")).toEqual({
      from: "@chernabog/recipes/implement",
      version: "0.1.0",
    });
  }, 60_000);

  test("recipes add copies more later, and never overwrites a flow the repo has", async () => {
    const added = await sandbox.runCli(["recipes", "add", "human-initiated", "review"]);
    expect(added.output).toContain(
      "wrote .chernabog/flows/human-initiated.ts (human-initiated recipe, 0.1.0)",
    );
    expect(added.output).toContain("kept .chernabog/flows/review.ts, which is already there");

    const listed = await sandbox.runCli(["recipes", "list"]);
    expect(listed.output).toContain("✓ human-initiated");
    expect(listed.output).toContain("  re-review");

    const refused = await sandbox.runCli(["recipes", "add", "ship"]);
    expect(refused.output).toContain("no recipe named ship");
  }, 30_000);

  test("recipes add copies from a company's package on a private registry, which only .npmrc configures", async () => {
    const host = new URL(sandbox.registry.url).host;
    writeFileSync(
      join(dir(), ".npmrc"),
      `@acme:registry=${sandbox.registry.url}\n//${host}/:_authToken=${ACME_TOKEN}\n`,
    );
    await bun("add", "--dev", "--exact", "@acme/recipes@1.0.0");

    const missing = await sandbox.runCli(["recipes", "add", "@globex/recipes/ship"]);
    expect(missing.output).toContain("@globex/recipes isn't installed in .chernabog/");

    const { output } = await sandbox.runCli(["recipes", "add", "@acme/recipes/deploy"]);
    expect(output).toContain(
      "wrote .chernabog/flows/deploy.ts (@acme/recipes/deploy recipe, 1.0.0)",
    );
    expect(output).toContain(
      "wrote .chernabog/prompts/deploy.md (@acme/recipes/deploy recipe, 1.0.0)",
    );
    expect(readFileSync(flow("deploy"), "utf8")).toBe(ACME_DEPLOY);

    const listed = await sandbox.runCli(["recipes", "list"]);
    expect(listed.output).toContain("@acme/recipes 1.0.0:");
    expect(listed.output).toContain("✓ @acme/recipes/deploy: Deploys what's labelled deploy");
    expect(
      sandbox.registry.requests.filter((request) => request.startsWith("@acme/recipes ")),
    ).toContain(`@acme/recipes Bearer ${ACME_TOKEN}`);
  }, 60_000);

  test("recipes diff shows how the repo's flows differ from the version each was copied from", async () => {
    writeFileSync(
      flow("implement"),
      readFileSync(flow("implement"), "utf8").replace("concurrency: 1,", "concurrency: 3,"),
    );
    const { code, output } = await sandbox.runCli(["recipes", "diff"]);
    expect(code).toBe(0);
    expect(output).toContain(
      ".chernabog/flows/implement.ts: differs from the implement recipe in @chernabog/recipes@0.1.0 (https://dataquail.github.io/chernabog/recipes/implement/)",
    );
    expect(output).toContain("-  concurrency: 1,\n+  concurrency: 3,");
    expect(output).toContain(
      ".chernabog/flows/review.ts: the same as the review recipe in @chernabog/recipes@0.1.0",
    );
    expect(output).toContain(
      ".chernabog/flows/deploy.ts: the same as the @acme/recipes/deploy recipe in @acme/recipes@1.0.0",
    );
  }, 30_000);

  test("recipes update moves the package to its newest version for the SDK and merges its changes into the repo's edits", async () => {
    const { code, output } = await sandbox.runCli(["recipes", "update"]);
    expect(code).toBe(0);
    expect(output).toContain(".chernabog/package.json: @chernabog/recipes 0.1.0 -> 0.2.0");
    expect(output).toContain(
      ".chernabog/flows/implement.ts: merged your edits with the implement recipe in 0.2.0",
    );
    expect(output).toContain("Nothing is committed.");

    const implement = readFileSync(flow("implement"), "utf8");
    expect(implement).toContain("concurrency: 3,");
    expect(implement.endsWith(UPSTREAM_FIX)).toBe(true);
    expect(copied("flows/implement.ts")?.version).toBe("0.2.0");
    expect(copied("flows/review.ts")?.version).toBe("0.2.0");

    const again = await sandbox.runCli(["recipes", "update"]);
    expect(again.output).toContain("The copied recipes are up to date; nothing changed");
  }, 60_000);

  test("recipes upgrade moves a repo on an older SDK to one this binary loads, listing what it can't", async () => {
    // What doctor says of the repo's .chernabog/, as committed to its base branch.
    const compatible = async () => {
      sandbox.git(sandbox.checkout, "add", ".");
      sandbox.git(sandbox.checkout, "commit", "-qm", "chore: change .chernabog/");
      // As pushed: this origin is only a name, so its ref is moved here.
      sandbox.git(sandbox.checkout, "update-ref", "refs/remotes/origin/main", "HEAD");

      return (await sandbox.runCli(["doctor"])).output;
    };

    // From before versions were recorded.
    writeFileSync(
      join(dir(), "package.json"),
      '{ "private": true, "engines": { "chernabog": ">=0.7.0" }, "devDependencies": { "@chernabog/sdk": "0.5.0", "effect": "4.0.0", "@chernabog/recipes": "0.2.0" } }\n',
    );
    writeFileSync(
      flow("review"),
      'import { defineFlow, Review } from "@chernabog/sdk";\nexport default defineFlow({ trigger: Review.fixTrigger, workflow: Review.labelVerdict });\n',
    );
    writeFileSync(
      flow("security"),
      'import { Claims, defineFlow } from "@chernabog/core";\nimport { Review } from "@chernabog/sdk";\nexport default defineFlow({ trigger: Review.trigger, workflow: () => Claims.releaseAll });\n',
    );
    expect(await compatible()).toContain(
      "demo: incompatible: .chernabog/: package.json still has engines.chernabog",
    );

    const { code, output } = await sandbox.runCli(["recipes", "upgrade"]);
    expect(code).toBe(0);
    expect(output).toContain(
      `.chernabog/package.json: lists @chernabog/sdk ${RELEASED_SDK} and pins this chernabog's @chernabog/core and effect`,
    );
    expect(output).toContain(
      ".chernabog/flows/review.ts: replaced, since nothing recorded which version it came from; review the diff",
    );
    expect(output).toContain(
      ".chernabog/flows/security.ts: from no recipe, left as it is; it imports what this chernabog's @chernabog/core doesn't have (Claims.releaseAll), so move it by hand",
    );
    expect(output).toContain("Nothing is committed.");
    expect(output).not.toContain("No recipe package is installed");
    expect(readFileSync(flow("review"), "utf8")).toBe(recipeFiles(["review"])["flows/review.ts"]);
    expect(manifest()).not.toHaveProperty("engines");
    expect(await compatible()).toContain("demo: incompatible: .chernabog/: flows import what");

    // The hand-written flow, moved by hand.
    writeFileSync(flow("security"), recipeFiles(["review"])["flows/review.ts"]);
    expect(await compatible()).toContain("demo: .chernabog/ needs a core this chernabog provides");
  }, 90_000);
});

describe("a repo baked before recipes were packages", () => {
  let sandbox: Sandbox;
  const flow = () => join(sandbox.checkout, ".chernabog/flows/implement.ts");

  // implement as an earlier chernabog baked it, before claims were refs.
  const baked = recipeFiles(["implement"])["flows/implement.ts"].replace(
    "        Claims.releasing(Claims.issue(issue)),\n",
    "",
  );

  beforeAll(() => {
    sandbox = openSandbox({}, { recipes: [], repoFiles: { "flows/implement.ts": baked } });
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

  test("recipes diff points to init, which installs @chernabog/recipes without touching a flow, so diff then shows what the recipe changed", async () => {
    expect(baked).not.toContain("Claims.releasing");

    const before = await sandbox.runCli(["recipes", "diff"]);
    expect(before.code).toBe(0);
    expect(before.output).toContain(".chernabog/flows/implement.ts: from no recipe");
    expect(before.output).toContain(
      "If an earlier chernabog baked them, chernabog init installs @chernabog/recipes",
    );

    const init = await sandbox.runCli(["init"]);
    expect(init.code).toBe(0);
    expect(init.output).toContain("added @chernabog/recipes 0.2.0 to .chernabog/package.json");
    expect(readFileSync(flow(), "utf8")).toBe(baked);

    const after = await sandbox.runCli(["recipes", "diff", "implement"]);
    expect(after.code).toBe(0);
    expect(after.output).toContain(
      ".chernabog/flows/implement.ts: differs from the implement recipe in @chernabog/recipes@0.2.0, the version installed",
    );
    expect(after.output).toContain("-        Claims.releasing(Claims.issue(issue)),");
    expect(after.output).not.toContain("No recipe package is installed");
  }, 90_000);
});
