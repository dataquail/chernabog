// scripts/mutation-issues.ts, run as the nightly workflow runs it, against the
// fake GitHub: one issue per module, holding the mutants no test notices.

import { fileURLToPath } from "node:url";

import { type Json, printJson } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { type Environment } from "../src/platform/environment.ts";
import { Exec, execOk } from "../src/platform/exec.ts";
import { startFakeGitHub } from "./acceptance/fake-github.ts";
import { effectAtHomeWith } from "./effect-test.ts";

const effect = effectAtHomeWith(Exec.layer);

const SLUG = "acme/widgets";
const SCRIPT = fileURLToPath(new URL("../scripts/mutation-issues.ts", import.meta.url));
const RUN_URL = "https://github.com/acme/widgets/actions/runs/77";

const EXAMPLE = [
  "// A fixture module.",
  "export const LIMIT = 3;",
  "",
  "export const within = (count: number) => {",
  "  return count <= LIMIT && count >= 0;",
  "};",
  "",
  "export function label(name: string) {",
  '  return name === "" ? "none" : name;',
  "}",
  "",
  "export const make = () => ({",
  "  size: (items: ReadonlyArray<string>) => items.length,",
  "});",
  "",
].join("\n");

const OTHER = 'export const NAME = "other";\n';

type Status = "Killed" | "Survived" | "NoCoverage" | "Timeout" | "Ignored";

// A mutant as the report gives it; an ignored one's reason is added where it's made.
const mutant = (
  id: string,
  mutatorName: string,
  status: Status,
  [startLine, startColumn, endLine, endColumn]: readonly [number, number, number, number],
  replacement: string,
  isStatic = false,
) => ({
  id,
  mutatorName,
  status,
  static: isStatic,
  replacement,
  location: {
    start: { line: startLine, column: startColumn },
    end: { line: endLine, column: endColumn },
  },
});

const IGNORED = {
  ...mutant("4", "ConditionalExpression", "Ignored", [9, 10, 9, 21], "false"),
  statusReason: "equivalent: the two branches agree",
};

const KILLED = mutant("5", "EqualityOperator", "Killed", [9, 10, 9, 21], 'name !== ""');

// A Timeout on a mutant that isn't static: a kill.
const TIMED_OUT = mutant("6", "BlockStatement", "Timeout", [8, 37, 10, 2], "{}");

// A Timeout on a static mutant: unverified.
const OTHER_FILE: Json = {
  language: "typescript",
  source: OTHER,
  mutants: [mutant("8", "StringLiteral", "Timeout", [1, 21, 1, 28], '""', true)],
};

// A report as Stryker's json reporter writes it: survivors in three functions
// of one file, beside the ignored, killed and timed-out mutants above.
const REPORT: Json = {
  schemaVersion: "1.0",
  thresholds: { high: 80, low: 60 },
  files: {
    "src/example.ts": {
      language: "typescript",
      source: EXAMPLE,
      mutants: [
        mutant("1", "EqualityOperator", "Survived", [5, 10, 5, 24], "count < LIMIT"),
        mutant("2", "ConditionalExpression", "Survived", [5, 10, 5, 38], "true"),
        mutant("3", "StringLiteral", "NoCoverage", [9, 24, 9, 30], '""'),
        IGNORED,
        KILLED,
        TIMED_OUT,
        mutant("7", "ArrowFunction", "Survived", [13, 9, 13, 55], "() => undefined"),
        mutant("9", "BlockStatement", "Survived", [4, 42, 6, 2], "{}"),
      ],
    },
    "src/other.ts": OTHER_FILE,
  },
};

// The same file with every mutant killed, or ignored.
const CLEAN_EXAMPLE: Json = {
  language: "typescript",
  source: EXAMPLE,
  mutants: [IGNORED, KILLED, TIMED_OUT],
};

const CLEAN: Json = {
  schemaVersion: "1.0",
  thresholds: { high: 80, low: 60 },
  files: { "src/example.ts": CLEAN_EXAMPLE },
};

const MARKER = '<!-- chernabog-mutation {"module":"example"} -->';

const BODY = `${MARKER}
Mutation testing of \`example\` leaves 5 mutants alive: changes to its code that no test notices. Each one marks a test that doesn't pin down the behaviour it covers. They're grouped by function, since one missing test often explains several.

1 static mutant timed out as well, which is unverified: see the last section.

The HTML report is in the \`mutation-example\` artifact of [the run](${RUN_URL}). To see it locally, run \`bun run mutation example\` and open \`reports/mutation/example/mutation.html\`.

## Survivors

### \`within\` in \`src/example.ts\`

- \`src/example.ts:4\` BlockStatement: \`{ …\` → \`{}\`
- \`src/example.ts:5\` EqualityOperator: \`count <= LIMIT\` → \`count < LIMIT\`
- \`src/example.ts:5\` ConditionalExpression: \`count <= LIMIT && count >= 0\` → \`true\`

### \`label\` in \`src/example.ts\`

- \`src/example.ts:9\` StringLiteral, no coverage: \`"none"\` → \`""\`

### \`make.size\` in \`src/example.ts\`

- \`src/example.ts:13\` ArrowFunction: \`(items: ReadonlyArray<string>) => items.length\` → \`() => undefined\`

## Unverified timeouts

A static mutant runs the module's whole test selection, so a Timeout on one can come from a slow test under load rather than a loop that never ends (docs/testing/mutation-spike.md). Run these again with a longer \`timeoutMS\` to tell.

### \`NAME\` in \`src/other.ts\`

- \`src/other.ts:1\` StringLiteral: \`"other"\` → \`""\`

---

\`scripts/mutation-issues.ts\` rewrites this body after each nightly run. Kill a survivor with a test that fails on the mutated code, written against the behaviour; mark an equivalent one \`// Stryker disable next-line <mutator>: <reason>\`. [How to act on this issue](https://dataquail.github.io/chernabog/contribute/mutation-testing/).
`;

const TITLE = "Surviving mutants in example";

// The fake GitHub over a bare repo in a fresh directory, and the script run
// there as the workflow runs it, with only the environment it's given.
const NIGHTLY: Environment = { GITHUB_REPOSITORY: SLUG, GH_TOKEN: "token-nightly" };

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "mutation-issues-" }));
  const bare = `${dir}/origin.git`;
  yield* execOk("git", ["init", "--quiet", "--bare", bare]);

  const github = yield* Effect.acquireRelease(
    Effect.sync(() => startFakeGitHub({ slug: SLUG, bare })),
    (started) => Effect.promise(() => started.stop()),
  );

  const path = yield* Config.String("PATH");

  const writeReport = (report: Json, folder = dir) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(`${folder}/mutation.json`, printJson(report));

      return `${folder}/mutation.json`;
    });

  const run = (args: ReadonlyArray<string>, env: Environment = NIGHTLY) =>
    Exec.use((exec) =>
      exec.run("bun", [SCRIPT, ...args], {
        cwd: dir,
        env: { PATH: path, HOME: dir, GITHUB_API_URL: github.url, ...env },
      }),
    );

  const writes = () => github.requests.filter((request) => !request.startsWith("GET "));

  return { dir, github, run, writeReport, writes };
});

describe("the survivor issue", () => {
  effect("is created with the survivors grouped by function, and no label", () =>
    Effect.gen(function* () {
      const { github, run, writeReport } = yield* fixture;
      const report = yield* writeReport(REPORT);

      const result = yield* run(["example", "--report", report, "--run-url", RUN_URL]);

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);

      expect(
        [...github.issues.values()].map(({ body, labels, title }) => ({ title, body, labels })),
      ).toEqual([{ title: TITLE, body: BODY, labels: [] }]);

      expect(result.stdout).toBe(`Created #${[...github.issues.keys()].join()}: ${TITLE}\n`);
    }),
  );

  effect("leaves out ignored and killed mutants, and Timeouts on ones that aren't static", () =>
    Effect.gen(function* () {
      const { github, run, writeReport } = yield* fixture;

      yield* run(["example", "--report", yield* writeReport(REPORT), "--run-url", RUN_URL]);

      const bodies = [...github.issues.values()].map((issue) => issue.body).join();

      expect(bodies).toContain("src/example.ts:9");
      expect(bodies).not.toContain("src/example.ts:8");
      expect(bodies).not.toContain("→ `false`");
      expect(bodies).not.toContain('`name !== ""`');
    }),
  );

  effect("is rewritten in place when the module's open issue has its marker", () =>
    Effect.gen(function* () {
      const { github, run, writeReport } = yield* fixture;
      const report = yield* writeReport(REPORT);
      const claims = '<!-- chernabog-mutation {"module":"claims"} -->\nOld.';
      const other = github.addIssue("Surviving mutants in claims", [], claims);
      const closed = github.addIssue(TITLE, [], `${MARKER}\nLong gone.`);
      github.issue(closed).closed = true;
      const open = github.addIssue("Old title", ["triaged"], `${MARKER}\nYesterday's survivors.`);

      const result = yield* run(["example", "--report", report, "--run-url", RUN_URL]);

      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`Updated #${open}: ${TITLE}\n`);
      expect(github.issues.size).toBe(3);
      expect(github.issue(open)).toMatchObject({ title: TITLE, body: BODY, labels: ["triaged"] });
      expect(github.issue(open).closed).not.toBe(true);
      expect(github.issue(other).body).toBe(claims);
      expect(github.issue(closed).body).toBe(`${MARKER}\nLong gone.`);
    }),
  );

  effect("is left alone when its body is already the one the report gives", () =>
    Effect.gen(function* () {
      const { github, run, writeReport, writes } = yield* fixture;
      const report = yield* writeReport(REPORT);
      const open = github.addIssue(TITLE, [], BODY);

      const result = yield* run(["example", "--report", report, "--run-url", RUN_URL]);

      expect(result.stdout).toBe(`#${open} is up to date.\n`);
      expect(writes()).toEqual([]);
    }),
  );

  effect("is commented on and closed once no mutant survives", () =>
    Effect.gen(function* () {
      const { github, run, writeReport } = yield* fixture;
      const report = yield* writeReport(CLEAN);
      const open = github.addIssue(TITLE, [], `${MARKER}\nYesterday's survivors.`);

      const result = yield* run(["example", "--report", report, "--run-url", RUN_URL]);

      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`Closed #${open}\n`);
      expect(github.issue(open).closed).toBe(true);

      expect(github.commentsOn(open).map((comment) => comment.body)).toEqual([
        `Mutation testing of \`example\` leaves no mutant alive as of [this run](${RUN_URL}), so this is done.`,
      ]);
    }),
  );

  effect("stays open while a static mutant's Timeout is unverified", () =>
    Effect.gen(function* () {
      const { github, run, writeReport } = yield* fixture;

      const report = yield* writeReport({
        files: { "src/example.ts": CLEAN_EXAMPLE, "src/other.ts": OTHER_FILE },
      });

      const open = github.addIssue(TITLE, [], `${MARKER}\nYesterday's survivors.`);

      yield* run(["example", "--report", report, "--run-url", RUN_URL]);

      const { body, closed } = github.issue(open);

      expect(closed).not.toBe(true);

      expect(body).toContain(
        "Mutation testing of `example` leaves no mutant alive, but 1 static mutant timed out, which is unverified: see the last section.",
      );

      expect(body).not.toContain("## Survivors");
      expect(body).toContain("## Unverified timeouts");
      expect(body).toContain("### `NAME` in `src/other.ts`");
    }),
  );

  effect("isn't filed when nothing survives and no issue is open", () =>
    Effect.gen(function* () {
      const { run, writeReport, writes } = yield* fixture;
      const report = yield* writeReport(CLEAN);

      const result = yield* run(["example", "--report", report]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("No surviving mutants in example, and no open issue to close.\n");
      expect(writes()).toEqual([]);
    }),
  );
});

describe("--dry-run", () => {
  effect("prints the issue it would create, and writes nothing", () =>
    Effect.gen(function* () {
      const { github, run, writeReport, writes } = yield* fixture;
      const report = yield* writeReport(REPORT);

      const result = yield* run(["example", "--report", report, "--run-url", RUN_URL, "--dry-run"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`Would create an issue: ${TITLE}\n\n${BODY}\n`);
      expect(writes()).toEqual([]);
      expect(github.issues.size).toBe(0);
    }),
  );

  effect("prints the issue it would update", () =>
    Effect.gen(function* () {
      const { github, run, writeReport, writes } = yield* fixture;
      const report = yield* writeReport(REPORT);
      const open = github.addIssue("Old title", [], `${MARKER}\nYesterday's survivors.`);

      const result = yield* run(["example", "--report", report, "--run-url", RUN_URL, "--dry-run"]);

      expect(result.stdout).toBe(`Would update #${open}: ${TITLE}\n\n${BODY}\n`);
      expect(writes()).toEqual([]);
    }),
  );

  effect("prints the issue it would close, and its comment", () =>
    Effect.gen(function* () {
      const { github, run, writeReport, writes } = yield* fixture;
      const report = yield* writeReport(CLEAN);
      const open = github.addIssue(TITLE, [], `${MARKER}\nYesterday's survivors.`);

      const result = yield* run(["example", "--report", report, "--dry-run"]);

      expect(result.stdout).toBe(
        `Would close #${open}, commenting:\n\nMutation testing of \`example\` leaves no mutant alive, so this is done.\n`,
      );

      expect(writes()).toEqual([]);
      expect(github.issue(open).closed).not.toBe(true);
    }),
  );
});

describe("the command", () => {
  effect("reads reports/mutation/<module>/mutation.json by default", () =>
    Effect.gen(function* () {
      const { dir, run, writeReport } = yield* fixture;
      yield* writeReport(REPORT, `${dir}/reports/mutation/example`);

      const result = yield* run(["example", "--dry-run"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toStartWith(`Would create an issue: ${TITLE}`);
      expect(result.stdout).toContain("To see the HTML report, run `bun run mutation example`");
    }),
  );

  effect("reads the repo from the git remote when GITHUB_REPOSITORY is unset", () =>
    Effect.gen(function* () {
      const { dir, github, run, writeReport } = yield* fixture;
      const report = yield* writeReport(REPORT);
      yield* execOk("git", ["init", "--quiet", dir]);
      yield* execOk("git", ["-C", dir, "remote", "add", "origin", `git@github.com:${SLUG}.git`]);

      const result = yield* run(["example", "--report", report], { GH_TOKEN: "token-nightly" });

      expect(result.stderr).toBe("");
      expect(github.issues.size).toBe(1);
    }),
  );

  effect("authenticates with GITHUB_TOKEN when GH_TOKEN is unset", () =>
    Effect.gen(function* () {
      const { github, run, writeReport } = yield* fixture;
      const report = yield* writeReport(REPORT);

      yield* run(["example", "--report", report], {
        GITHUB_REPOSITORY: SLUG,
        GITHUB_TOKEN: "token-actions",
      });

      expect(github.requestsBy.filter((request) => request.startsWith("actions POST"))).toEqual([
        `actions POST /repos/${SLUG}/issues`,
      ]);
    }),
  );

  effect("fails without a token, and writes nothing", () =>
    Effect.gen(function* () {
      const { github, run, writeReport } = yield* fixture;
      const report = yield* writeReport(REPORT);

      const result = yield* run(["example", "--report", report], { GITHUB_REPOSITORY: SLUG });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("set GH_TOKEN (or GITHUB_TOKEN)");
      expect(github.issues.size).toBe(0);
    }),
  );

  effect("fails on a report it can't read", () =>
    Effect.gen(function* () {
      const { dir, run } = yield* fixture;

      const result = yield* run(["example", "--report", `${dir}/missing.json`]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`couldn't read ${dir}/missing.json`);
    }),
  );
});
