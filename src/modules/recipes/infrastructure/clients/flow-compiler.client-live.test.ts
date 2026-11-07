import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { effectAtHomeWith } from "../../../../../test/effect-test.ts";
import { Exec } from "../../../../platform/exec.ts";
import { FlowCompilerClient } from "../../domain/ports/clients/flow-compiler.client.ts";
import {
  diagnosticsOf,
  FlowCompilerClientLive,
  notCheckedBecause,
  pathKeys,
  pathOfLine,
  positionOf,
} from "./flow-compiler.client-live.ts";

const atHome = effectAtHomeWith(Exec.layer);

const TIMEOUT = 120_000;

const REVIEW_DOCUMENT = `flow: review
subject: pull-request
trigger:
  - use: review.requested
steps:
  - id: review
    use: review.round
    in: { pr: trigger.pr }
    with: { round: 1, role: reviewer }
    on:
      approve:
        as: verdict
        steps:
          - id: land
            use: pr.land
            in: { pr: trigger.pr, approved: verdict.approved }
            with: { method: squash }
          - end: done
            summary: land
      changes:
        steps:
          - end: done
            summary: review.changesAsked
`;

// A checkout with these documents, under node_modules so that what it installs
// is this repo's: its SDK, effect and, when `typescript`, TypeScript.
const checkout = (
  documents: { readonly [flow: string]: string },
  options: { readonly typescript: boolean },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const modules = yield* path.fromFileUrl(
      new URL("../../../../../node_modules", import.meta.url),
    );

    const cache = path.join(modules, ".cache");

    yield* fs.makeDirectory(cache, { recursive: true });
    const root = yield* fs.makeTempDirectoryScoped({ directory: cache, prefix: "compile-" });

    const dir = path.join(root, ".chernabog");
    yield* fs.makeDirectory(path.join(dir, "documents"), { recursive: true });

    if (options.typescript) {
      yield* fs.symlink(modules, path.join(dir, "node_modules"));
    } else {
      yield* fs.makeDirectory(path.join(dir, "node_modules", "@chernabog"), { recursive: true });
      yield* fs.symlink(path.join(modules, "effect"), path.join(dir, "node_modules", "effect"));

      for (const name of ["core", "sdk"]) {
        yield* fs.symlink(
          path.join(modules, "@chernabog", name),
          path.join(dir, "node_modules", "@chernabog", name),
        );
      }
    }

    for (const [flow, text] of Object.entries(documents)) {
      yield* fs.writeFileString(path.join(dir, "documents", `${flow}.yaml`), text);
    }

    return root;
  });

// As `compiling`, with this as the repo's `tsc`.
const compilingWithTsc = (script: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* checkout({ review: REVIEW_DOCUMENT }, { typescript: false });
    const bin = `${root}/.chernabog/node_modules/.bin`;

    yield* fs.makeDirectory(bin, { recursive: true });
    yield* fs.writeFileString(`${bin}/tsc`, script);

    const compiler = yield* FlowCompilerClient;

    return yield* compiler.compile(root, "review");
  }).pipe(Effect.provide(Layer.fresh(FlowCompilerClientLive)));

const compiling = (
  documents: { readonly [flow: string]: string },
  flow: string,
  options = { typescript: true },
) =>
  Effect.gen(function* () {
    const root = yield* checkout(documents, options);
    const compiler = yield* FlowCompilerClient;

    return yield* compiler.compile(root, flow);
  }).pipe(Effect.provide(Layer.fresh(FlowCompilerClientLive)));

describe("FlowCompilerClientLive", () => {
  atHome(
    "compiles a document by the repo's SDK, and checks its wires with the repo's TypeScript",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compiling({ review: REVIEW_DOCUMENT }, "review");

        expect(compiled.problems).toEqual([]);
        expect(compiled.typeChecked).toBe(true);
        expect(Option.getOrElse(compiled.source, () => "")).toContain("// steps[0]");
      }),
    TIMEOUT,
  );

  atHome(
    "says so when there is no TypeScript to check the wires with",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compiling({ review: REVIEW_DOCUMENT }, "review", {
          typescript: false,
        });

        expect(compiled.problems).toEqual([]);
        expect(compiled.typeChecked).toBe(false);
        expect(Option.isSome(compiled.source)).toBe(true);
      }),
    TIMEOUT,
  );

  for (const [what, script, says] of [
    ["crashes", 'console.error("Segfault"); process.exit(1);', "Segfault"],
    [
      "rejects its project",
      "console.log(\"tsconfig.json(4,15): error TS6046: Argument for '--module' must be.\"); process.exit(1);",
      "TS6046",
    ],
    [
      "fails with a diagnostic of no file",
      'console.log("error TS5083: Cannot read file."); process.exit(1);',
      "TS5083",
    ],
    ["exits non-zero saying nothing", "process.exit(3);", "exited 3"],
  ] as const) {
    atHome(
      `doesn't say types were checked when tsc ${what}, and writes no flow on its word`,
      () =>
        Effect.gen(function* () {
          const compiled = yield* compilingWithTsc(script);

          expect(compiled.typeChecked).toBe(false);
          expect(Option.isNone(compiled.source)).toBe(true);
          expect(compiled.problems.map((each) => each.path)).toEqual([""]);
          expect(compiled.problems[0]?.message).toContain("couldn't check");
          expect(compiled.problems[0]?.message).toContain(says);
        }),
      TIMEOUT,
    );
  }

  atHome(
    "takes a clean exit from tsc as a check",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compilingWithTsc("process.exit(0);");

        expect(compiled.problems).toEqual([]);
        expect(compiled.typeChecked).toBe(true);
      }),
    TIMEOUT,
  );

  atHome(
    "reports a check's problem at its line in the document",
    () =>
      Effect.gen(function* () {
        const text =
          "flow: review\nsubject: pull-request\ntrigger:\n  - use: review.requested\nsteps:\n  - id: first\n    use: gate.lint\n";

        const compiled = yield* compiling({ review: text }, "review");

        expect(Option.isNone(compiled.source)).toBe(true);
        expect(compiled.problems.map((each) => [each.file, each.line, each.path])).toEqual([
          [".chernabog/documents/review.yaml", 7, "steps[0].use"],
        ]);
        expect(compiled.problems[0]?.message).toContain("no block named gate.lint");
      }),
    TIMEOUT,
  );

  atHome(
    "traces a type error from the generated flow back to the wire in the document",
    () =>
      Effect.gen(function* () {
        const text = REVIEW_DOCUMENT.replace("approved: verdict.approved", "approved: trigger.pr");
        const compiled = yield* compiling({ review: text }, "review");

        expect(Option.isNone(compiled.source)).toBe(true);

        const wrongLine = text
          .split("\n")
          .findIndex((line) => line.includes("approved: trigger.pr"));

        expect(compiled.problems.map((each) => [each.line, each.path])).toEqual([
          [wrongLine + 1, "steps[0].on.approve.steps[0].in.approved"],
        ]);

        expect(compiled.problems[0]?.message).toContain("Approved");
      }),
    TIMEOUT,
  );

  atHome(
    "reports a type error in a fixed value at the value, in `with`",
    () =>
      Effect.gen(function* () {
        const text = REVIEW_DOCUMENT.replace("method: squash", "method: bogus");
        const compiled = yield* compiling({ review: text }, "review");

        const wrongLine = text.split("\n").findIndex((line) => line.includes("method: bogus"));

        expect(compiled.problems.map((each) => [each.line, each.path])).toEqual([
          [wrongLine + 1, "steps[0].on.approve.steps[0].with.method"],
        ]);
      }),
    TIMEOUT,
  );

  atHome(
    "reports YAML that doesn't parse, and a document of the wrong form, without compiling",
    () =>
      Effect.gen(function* () {
        const broken = yield* compiling({ broken: "flow: [unclosed\n" }, "broken");
        expect(broken.problems.length).toBeGreaterThan(0);

        const formless = yield* compiling({ formless: "flow: x\n" }, "formless");

        expect(formless.problems.length).toBe(1);
      }),
    TIMEOUT,
  );

  atHome("lists a checkout's documents, and writes a flow file it can read back", () =>
    Effect.gen(function* () {
      const root = yield* checkout({ b: "x", a: "y" }, { typescript: false });
      const compiler = yield* FlowCompilerClient;

      expect(yield* compiler.documents(root)).toEqual(["a", "b"]);
      expect(Option.isNone(yield* compiler.written(root, "a"))).toBe(true);
      yield* compiler.write(root, "a", "source");
      expect(yield* compiler.written(root, "a")).toEqual(Option.some("source"));
    }).pipe(Effect.provide(Layer.fresh(FlowCompilerClientLive))),
  );
});

describe("whether tsc checked anything", () => {
  const run = (exitCode: number, stdout: string, stderr = "") => ({ exitCode, stdout, stderr });

  atHome("a clean run did", () =>
    Effect.sync(() => {
      expect(Option.isNone(notCheckedBecause(run(0, "")))).toBe(true);
    }),
  );

  atHome("a run that fails about files did, these being the SDK's or the flow's", () =>
    Effect.sync(() => {
      const sdk = "../../sdk/src/x.ts(1,20): error TS2307: Cannot find module 'node:crypto'.\n";

      expect(Option.isNone(notCheckedBecause(run(2, sdk)))).toBe(true);
      expect(Option.isNone(notCheckedBecause(run(2, "flow.ts(3,5): error TS2322: No.\n")))).toBe(
        true,
      );
    }),
  );

  atHome("a run that said anything of its project, or of no file, didn't", () =>
    Effect.sync(() => {
      const beside = "flow.ts(3,5): error TS2322: No.\n";

      expect(
        notCheckedBecause(run(1, `${beside}tsconfig.json(4,15): error TS6046: Bad module.\n`)),
      ).toEqual(Option.some("TS6046: Bad module."));
      expect(notCheckedBecause(run(1, `error TS5083: Cannot read.\n${beside}`))).toEqual(
        Option.some("TS5083: Cannot read."),
      );
    }),
  );

  atHome("a run that fails saying nothing of any file didn't, whatever else it said", () =>
    Effect.sync(() => {
      expect(notCheckedBecause(run(1, "", "\n  Segfault\n  at x\n"))).toEqual(
        Option.some("Segfault"),
      );
      expect(notCheckedBecause(run(1, "Oh no\n"))).toEqual(Option.some("Oh no"));
      expect(notCheckedBecause(run(9, ""))).toEqual(Option.some("it exited 9, saying nothing"));
    }),
  );
});

describe("finding a problem in the document", () => {
  const text = "steps:\n  - id: first\n    in:\n      worktree: claim.branch\n";

  atHome("reads a path as a YAML document's keys", () =>
    Effect.sync(() => {
      expect(pathKeys("steps[2].on.needs-clarification.steps[0]")).toEqual([
        "steps",
        2,
        "on",
        "needs-clarification",
        "steps",
        0,
      ]);
    }),
  );

  atHome("finds a path's line and column", () =>
    Effect.sync(() => {
      expect(positionOf(text, "steps[0].in.worktree")).toEqual({ line: 4, column: 17 });
    }),
  );

  atHome("falls back to the deepest part of a path the document has", () =>
    Effect.sync(() => {
      expect(positionOf(text, "steps[0].in.colour").line).toBe(4);
      expect(positionOf(text, "nothing.at.all")).toEqual({ line: 1, column: 1 });
    }),
  );

  atHome(
    "traces a line of the generated flow to its step, and a key to where the document has it",
    () =>
      Effect.sync(() => {
        const source = 'x\n  // steps[1]\n  const a = run({ "issue": 1 });\n  more();\n';
        const document = (keyed: string) => `steps:\n  - end: done\n  - id: a\n    ${keyed}\n`;

        expect(pathOfLine(source, document("in: { issue: b.c }"), 3, 19)).toBe("steps[1].in.issue");
        expect(pathOfLine(source, document("with: { issue: 1 }"), 3, 19)).toBe(
          "steps[1].with.issue",
        );
        expect(pathOfLine(source, document("failure: { issue: 1 }"), 3, 19)).toBe(
          "steps[1].failure.issue",
        );
        expect(pathOfLine(source, document("next: { issue: b.c }"), 3, 19)).toBe(
          "steps[1].next.issue",
        );
        expect(pathOfLine(source, document("use: a"), 3, 19)).toBe("steps[1]");
        expect(pathOfLine(source, document("in: { issue: b.c }"), 4, 3)).toBe("steps[1]");
        expect(pathOfLine(source, document("in: { issue: b.c }"), 1, 1)).toBe("steps");
      }),
  );

  atHome("keeps only what tsc says of the generated flow", () =>
    Effect.sync(() => {
      const said =
        "flow.ts(3,5): error TS2322: Type 'A' is wrong.\n  more detail\nother.ts(1,1): error TS1: no\n";

      expect(diagnosticsOf(said)).toEqual([{ line: 3, column: 5, message: "Type 'A' is wrong." }]);
    }),
  );
});
