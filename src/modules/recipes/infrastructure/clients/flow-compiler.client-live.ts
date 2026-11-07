// Flow documents compiled by the SDK the repo pins, from .chernabog/node_modules,
// as its flows are loaded: this binary holds no blocks of its own. A problem is
// reported where it is in the document. `check`'s already say their path there;
// `tsc`'s are about the generated file, whose comments name the step each line
// came from.

import { printJson } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import YAML from "yaml";

import { HostEnvironment } from "../../../../platform/environment.ts";
import { Exec } from "../../../../platform/exec.ts";
import { loadRepoSdk } from "../../../../platform/flow-loader.ts";
import { bunExecutable } from "../../../../platform/self.ts";
import {
  type CompiledDocument,
  DocumentProblem,
  FlowCompilerClient,
} from "../../domain/ports/clients/flow-compiler.client.ts";
import { RecipeFilesFailed } from "../../domain/recipe/recipe.errors.ts";

const DOCUMENT = /^(.+)\.ya?ml$/;

const documentsOf = (root: string) => `${root}/.chernabog/documents`;

const TSCONFIG = {
  compilerOptions: {
    target: "esnext",
    module: "preserve",
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    types: [],
  },
  include: ["flow.ts"],
};

// `steps[2].in.worktree` as the keys a YAML document goes by.
export const pathKeys = (path: string): ReadonlyArray<string | number> =>
  path.split(".").flatMap((part) =>
    [...part.matchAll(/[^[\]]+/g)].map(([key]) =>
      Option.getOrElse(
        Option.liftPredicate(Number(key), () => /^\d+$/.test(key)),
        () => key,
      ),
    ),
  );

// Where in the document a path is: the deepest part of it the document has.
export const positionOf = (text: string, path: string) => {
  const lines = new YAML.LineCounter();
  const document = YAML.parseDocument(text, { lineCounter: lines });
  const keys = pathKeys(path);

  const nodes = Arr.range(0, keys.length)
    .toReversed()
    .flatMap((length) => {
      const node = document.getIn(keys.slice(0, length), true);

      return Option.toArray(
        Option.filter(Option.fromNullishOr(node), YAML.isNode).pipe(
          Option.flatMap((found) => Option.fromNullishOr(found.range)),
        ),
      );
    });

  return Option.match(Arr.head(nodes), {
    onNone: () => ({ line: 1, column: 1 }),
    onSome: ([start]) => {
      const { col, line } = lines.linePos(start);

      return { line, column: col };
    },
  });
};

const DIAGNOSTIC = /^flow\.ts\((\d+),(\d+)\): error TS\d+: (.*)$/;

const STEP_COMMENT = /^\s*\/\/ (steps\S*)$/;

// Where a step's keys can be in its document. A generated call takes `in` and
// `with` in one object, so its key doesn't say which; the document does.
const KEYED = ["in", "with", "failure", "next"];

// The document path a line of the generated flow came from: the step its
// nearest comment above names, and, at a key of that step's, the key where the
// document has it.
export const pathOfLine = (source: string, text: string, line: number, column: number) => {
  const lines = source.split("\n");

  const step = lines
    .slice(0, line)
    .toReversed()
    .flatMap((each) => Option.toArray(Option.fromNullishOr(STEP_COMMENT.exec(each)?.[1])));

  const wire = Option.fromNullishOr(
    /^"([^"]+)":/.exec((lines[line - 1] ?? "").slice(column - 1))?.[1],
  );

  return Option.match(Arr.head(step), {
    onNone: () => "steps",
    onSome: (found) =>
      Option.match(wire, {
        onNone: () => found,
        onSome: (key) => {
          const document = YAML.parseDocument(text);

          return Option.getOrElse(
            Arr.findFirst(
              KEYED.map((keyed) => `${found}.${keyed}.${key}`),
              (path) => document.hasIn(pathKeys(path)),
            ),
            () => found,
          );
        },
      }),
  });
};

// What `tsc` said of the generated flow, as lines about it.
export const diagnosticsOf = (output: string) =>
  output.split("\n").flatMap((each) =>
    Option.toArray(
      Option.map(Option.fromNullishOr(DIAGNOSTIC.exec(each)), (match) => ({
        line: Number(match[1]),
        column: Number(match[2]),
        message: match[3],
      })),
    ),
  );

const ABOUT_THE_RUN = /^(?:tsconfig\.json\(\d+,\d+\): )?error (TS\d+: .*)$/;

const ABOUT_A_FILE = /^.+\(\d+,\d+\): error TS\d+: /;

// Why a run of `tsc` checked nothing, if it didn't. Its exit code alone can't
// say: a healthy run exits non-zero on the SDK's own sources, whose node: imports
// don't resolve under `types: []`, and says so about those files. So a run that
// fails saying nothing of any file never got to them, and one that says anything
// of its project, or of no file at all, couldn't trust what it read.
export const notCheckedBecause = (result: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}) => {
  const said = result.stdout.split("\n");

  const aboutTheRun = said.flatMap((each) =>
    Option.toArray(Option.fromNullishOr(ABOUT_THE_RUN.exec(each)?.[1])),
  );

  if (aboutTheRun.length > 0) {
    return Arr.head(aboutTheRun);
  }

  if (result.exitCode === 0 || said.some((each) => ABOUT_A_FILE.test(each))) {
    return Option.none();
  }

  const lines = `${result.stderr}\n${result.stdout}`.split("\n").map((each) => each.trim());

  return Option.some(
    Option.getOrElse(
      Arr.findFirst(lines, (each) => each.length > 0),
      () => `it exited ${result.exitCode}, saying nothing`,
    ),
  );
};

const failed = (error: { readonly message: string }) =>
  new RecipeFilesFailed({ message: error.message });

export const FlowCompilerClientLive = Layer.effect(
  FlowCompilerClient,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exec = yield* Exec;
    const host = yield* HostEnvironment;

    const fileOf = (root: string, flow: string) =>
      Effect.gen(function* () {
        const names = [`${flow}.yaml`, `${flow}.yml`].map((name) => `${documentsOf(root)}/${name}`);
        const found = yield* Effect.filter(names, (name) => fs.exists(name));

        return Option.getOrElse(Arr.head(found), () => names[0]);
      });

    // TypeScript as the repo has it: beside its flows, or at the checkout's root.
    const findTsc = (root: string) =>
      Effect.filter(
        [`${root}/.chernabog/node_modules/.bin/tsc`, `${root}/node_modules/.bin/tsc`],
        (path) => fs.exists(path),
      ).pipe(Effect.map(Arr.head));

    // Checks the flow beside the repo's, in a directory of its own that goes
    // with this check, so that resolving what it imports is as the repo's flows do.
    const typeProblems = (root: string, tsc: string, source: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* fs.makeTempDirectoryScoped({
            directory: `${root}/.chernabog`,
            prefix: ".compile-",
          });

          yield* fs.writeFileString(`${directory}/flow.ts`, source);
          yield* fs.writeFileString(`${directory}/tsconfig.json`, printJson(TSCONFIG));

          const result = yield* exec.run(
            bunExecutable(),
            [tsc, "-p", "tsconfig.json", "--pretty", "false"],
            {
              cwd: directory,
              env: { ...host.variables, BUN_BE_BUN: "1" },
              timeout: "5 minutes",
            },
          );

          return {
            notChecked: notCheckedBecause(result),
            found: diagnosticsOf(result.stdout),
          };
        }),
      );

    const compile = (root: string, flow: string) =>
      Effect.gen(function* () {
        const file = yield* fileOf(root, flow);
        const shown = `.chernabog/documents/${file.split("/").at(-1) ?? ""}`;
        const text = yield* fs.readFileString(file);

        const problemAt = (path: string, message: string) => {
          const { column, line } = positionOf(text, path);

          return new DocumentProblem({ file: shown, line, column, path, message });
        };

        const onlyProblems = (problems: ReadonlyArray<DocumentProblem>): CompiledDocument => ({
          source: Option.none(),
          problems,
          typeChecked: false,
        });

        const parsed = YAML.parseDocument(text);

        if (parsed.errors.length > 0) {
          return onlyProblems(parsed.errors.map((error) => problemAt("", error.message)));
        }

        const contents = Schema.decodeUnknownOption(Schema.Json)(parsed.toJS());

        if (Option.isNone(contents)) {
          return onlyProblems([problemAt("", "holds something that isn't plain data")]);
        }

        const compose = yield* loadRepoSdk(`${root}/.chernabog`);
        const read = compose.read(contents.value);

        if (Result.isFailure(read)) {
          return onlyProblems([problemAt("", read.failure.message)]);
        }

        const generated = compose.generate(read.success);

        if (Result.isFailure(generated)) {
          return onlyProblems(generated.failure.map((each) => problemAt(each.path, each.message)));
        }

        const source = generated.success;

        const tsc = yield* findTsc(root);

        if (Option.isNone(tsc)) {
          return { source: Option.some(source), problems: [], typeChecked: false };
        }

        const { found, notChecked } = yield* typeProblems(root, tsc.value, source);

        // Saying nothing of the types would pass as having checked them.
        if (Option.isSome(notChecked)) {
          return onlyProblems([
            problemAt("", `TypeScript couldn't check this document's types: ${notChecked.value}`),
          ]);
        }

        if (found.length > 0) {
          return onlyProblems(
            found.map((each) =>
              problemAt(pathOfLine(source, text, each.line, each.column), each.message),
            ),
          );
        }

        return { source: Option.some(source), problems: [], typeChecked: true };
      }).pipe(Effect.mapError(failed));

    return FlowCompilerClient.of({
      documents: (root) =>
        Effect.gen(function* () {
          if (!(yield* fs.exists(documentsOf(root)))) {
            return [];
          }

          const names = yield* fs.readDirectory(documentsOf(root));

          return names
            .flatMap((name) => Option.toArray(Option.fromNullishOr(DOCUMENT.exec(name)?.[1])))
            .toSorted();
        }).pipe(Effect.mapError(failed)),

      compile,

      written: (root, flow) =>
        Effect.gen(function* () {
          const path = `${root}/.chernabog/flows/${flow}.ts`;

          if (!(yield* fs.exists(path))) {
            return Option.none<string>();
          }

          return Option.some(yield* fs.readFileString(path));
        }).pipe(Effect.mapError(failed)),

      write: (root, flow, source) =>
        fs
          .makeDirectory(`${root}/.chernabog/flows`, { recursive: true })
          .pipe(
            Effect.andThen(fs.writeFileString(`${root}/.chernabog/flows/${flow}.ts`, source)),
            Effect.mapError(failed),
          ),
    });
  }),
);
