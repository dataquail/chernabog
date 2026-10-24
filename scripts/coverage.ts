// The Markdown coverage summary CI writes to the job summary, from the
// coverage/lcov.info `bun test` leaves, and the floor its totals must hold.

import * as Arr from "effect/Array";
import * as Bool from "effect/Boolean";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

type Counts = { readonly found: number; readonly hit: number };

export type FileCoverage = {
  readonly path: string;
  readonly lines: Counts;
  readonly functions: Counts;
};

export type Threshold = { readonly lines: number; readonly functions: number };

// Coverage when the floor was set, rounded down: it stops regressions, it is not
// a target. Raise it when coverage rises. It is here, not bunfig.toml's
// coverageThreshold, because Bun holds every file to that, not the total.
export const floor: Threshold = { lines: 0.91, functions: 0.67 };

const field = (record: ReadonlyArray<string>, key: string) =>
  Option.map(
    Arr.findFirst(record, (line) => line.startsWith(`${key}:`)),
    (line) => line.slice(key.length + 1),
  );

const count = (record: ReadonlyArray<string>, key: string) =>
  Option.getOrElse(Option.map(field(record, key), Number), () => 0);

export const parseLcov = (text: string): Array<FileCoverage> =>
  text.split("end_of_record").flatMap((block) => {
    const record = block.split("\n").map((line) => line.trim());

    return Option.toArray(
      Option.map(field(record, "SF"), (path) => ({
        path,
        lines: { found: count(record, "LF"), hit: count(record, "LH") },
        functions: { found: count(record, "FNF"), hit: count(record, "FNH") },
      })),
    );
  });

// Bun counts a module that only declares (schemas, classes, ports) as one
// function that never ran, though every line did. Its 0% says nothing.
export const declaresOnly = (file: FileCoverage) =>
  file.functions.found === 1 && file.functions.hit === 0 && file.lines.hit === file.lines.found;

// Nothing to cover is fully covered, as Bun counts it.
const fraction = ({ found, hit }: Counts) => hit / Math.max(found, 1) + Number(found === 0);

// What bun test gates on: the mean of each file's fraction, as its "All files" row.
export const totals = (files: ReadonlyArray<FileCoverage>): Threshold => {
  const mean = (measure: (file: FileCoverage) => number) =>
    Arr.match(files, {
      onEmpty: () => 1,
      onNonEmpty: (all) => all.reduce((sum, file) => sum + measure(file), 0) / all.length,
    });

  return {
    lines: mean((file) => fraction(file.lines)),
    functions: mean((file) => fraction(file.functions)),
  };
};

const percent = (value: number) => `${(value * 100).toFixed(2)}%`;

// Each total below its threshold, as a sentence.
export const shortfalls = (files: ReadonlyArray<FileCoverage>, threshold: Threshold) => {
  const total = totals(files);

  return (["lines", "functions"] as const).flatMap((measure) =>
    Bool.match(total[measure] < threshold[measure], {
      onFalse: () => [],
      onTrue: () => [
        `${measure} coverage is ${percent(total[measure])}, below the floor of ${percent(threshold[measure])}`,
      ],
    }),
  );
};

const byPath = Order.mapInput(Order.String, (file: FileCoverage) => file.path);

export const renderSummary = (files: ReadonlyArray<FileCoverage>, threshold: Threshold): string => {
  const total = totals(files);

  const row = (name: string, measured: number, minimum: number) =>
    `| ${name} | ${percent(measured)} | ${percent(minimum)} | ${Bool.match(measured >= minimum, {
      onFalse: () => "❌",
      onTrue: () => "✅",
    })} |`;

  const fileRow = (file: FileCoverage) =>
    `| \`${file.path}\` | ${percent(fraction(file.lines))} | ${Bool.match(declaresOnly(file), {
      onFalse: () => percent(fraction(file.functions)),
      onTrue: () => "n/a",
    })} |`;

  return [
    "## Coverage",
    "",
    "| | Measured | Threshold | |",
    "| --- | ---: | ---: | --- |",
    row("Lines", total.lines, threshold.lines),
    row("Functions", total.functions, threshold.functions),
    "",
    `<details><summary>${files.length} files</summary>`,
    "",
    "| File | Lines | Functions |",
    "| --- | ---: | ---: |",
    ...Arr.sort(files, byPath).map(fileRow),
    "",
    "Functions is n/a for a module that only declares: Bun counts it one function that never ran, though every line did.",
    "",
    "</details>",
    "",
  ].join("\n");
};
