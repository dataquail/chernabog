// The base of a repo's .chernabog/ that `chernabog init` writes before any
// recipe: config, schema and pins. A file already there is the repo's, so
// it's left as it is, except the schemas generated from this binary's config,
// which are brought up to date. And the repo's .gitignore gains what
// .chernabog/ installs, unless it covers it already.

import * as Option from "effect/Option";
import * as Record from "effect/Record";

export type Scaffold = {
  // Every file but package.json, by path under .chernabog/, as this binary
  // writes it.
  readonly files: Readonly<Record<string, string>>;
  // The ones generated from this binary, which are rewritten when they differ.
  readonly generated: ReadonlyArray<string>;
  // package.json for a .chernabog/ that has none: this binary's pins. One
  // that's there keeps its own, but for the pins of what this binary bundles.
  readonly manifest: string;
};

export type ScaffoldWrite = {
  readonly file: string;
  readonly text: string;
  // Whether it was there before, so this brings it up to date.
  readonly updated: boolean;
};

// What to write of the scaffold, given what the repo has of it.
export const scaffoldWrites = (
  scaffold: Scaffold,
  present: (file: string) => Option.Option<string>,
): ReadonlyArray<ScaffoldWrite> =>
  Record.toEntries(scaffold.files).flatMap(([file, text]) =>
    Option.match(present(file), {
      onNone: () => [{ file, text, updated: false }],
      onSome: (there) =>
        Option.toArray(
          Option.liftPredicate(
            { file, text, updated: true },
            () => scaffold.generated.includes(file) && there !== text,
          ),
        ),
    }),
  );

// Each .gitignore entry the scaffold needs, unless one of the lines it lists
// is there already.
const IGNORED: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  [".chernabog/node_modules/", ["node_modules", "node_modules/"]],
];

export const missingIgnores = (gitignore: string) => {
  const lines = gitignore.split("\n").map((line) => line.trim());

  return IGNORED.flatMap(([entry, covering]) =>
    Option.toArray(
      Option.liftPredicate(entry, () => ![entry, ...covering].some((line) => lines.includes(line))),
    ),
  );
};

// What to append to a .gitignore holding `gitignore` to ignore `missing`, on a
// line of its own.
export const ignoresToAppend = (gitignore: string, missing: ReadonlyArray<string>) => {
  const separator = Option.getOrElse(
    Option.liftPredicate("\n", () => gitignore.length > 0 && !gitignore.endsWith("\n")),
    () => "",
  );

  return `${separator}${missing.join("\n")}\n`;
};
