// Writes the coverage summary to $GITHUB_STEP_SUMMARY, or prints it when that is
// unset, then fails if a total is below the floor. CI runs it after `bun test`,
// whether or not the tests passed.
// Run: bun test && bun scripts/coverage-summary.ts

import { fileURLToPath } from "node:url";

import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as Arr from "effect/Array";
import * as Bool from "effect/Boolean";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { floor, parseLcov, renderSummary, shortfalls } from "./coverage.ts";

class CoverageError extends Schema.TaggedError<
  CoverageError,
  { readonly brand: "CoverageError" }
>()("CoverageError", {
  message: Schema.String,
}) {}

const lcov = fileURLToPath(new URL("../coverage/lcov.info", import.meta.url));

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  const files = yield* Bool.match(yield* fs.exists(lcov), {
    onFalse: () => Effect.succeed(Option.none<ReturnType<typeof parseLcov>>()),
    onTrue: () => Effect.map(fs.readFileString(lcov), (text) => Option.some(parseLcov(text))),
  });

  const summary = Option.match(files, {
    onNone: () => "## Coverage\n\n`bun test` wrote no coverage/lcov.info.\n",
    onSome: (all) => renderSummary(all, floor),
  });

  const target = Option.filter(
    yield* Config.option(Config.String("GITHUB_STEP_SUMMARY")),
    (path) => path !== "",
  );

  yield* Option.match(target, {
    onNone: () => Console.log(summary),
    onSome: (path) => fs.writeFileString(path, summary, { flag: "a" }),
  });

  const problems = Option.match(files, {
    onNone: () => ["bun test wrote no coverage/lcov.info"],
    onSome: (all) => shortfalls(all, floor),
  });

  yield* Arr.match(problems, {
    onEmpty: () => Effect.void,
    onNonEmpty: (all) => Effect.fail(new CoverageError({ message: all.join("; ") })),
  });
});

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));
