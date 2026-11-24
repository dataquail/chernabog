// What a module's mutation report says needs work, as the issue that holds
// it (epic #574, decision 4): the mutants no test notices, grouped by the
// function they're in, since one missing test often explains several, and
// the Timeouts on static mutants, which are unverified rather than killed
// (docs/testing/mutation-spike.md, Q2). mutation-issues.ts files it.

import { printJson } from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Bool from "effect/Boolean";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import ts from "typescript";

const Position = Schema.Struct({ line: Schema.Finite, column: Schema.Finite });

// A mutant as Stryker's json reporter writes it, with what this reads of it.
const Mutant = Schema.Struct({
  id: Schema.String,
  mutatorName: Schema.String,
  replacement: Schema.optionalKey(Schema.String),
  status: Schema.String,
  static: Schema.optionalKey(Schema.Boolean),
  location: Schema.Struct({ start: Position, end: Position }),
});

type Mutant = typeof Mutant.Type;

// A module's mutation.json: each mutated file's source and its mutants.
export const MutationReport = Schema.fromJsonString(
  Schema.Struct({
    files: Schema.Record(
      Schema.String,
      Schema.Struct({ source: Schema.String, mutants: Schema.Array(Mutant) }),
    ),
  }),
);

export type MutationReport = typeof MutationReport.Type;

// One mutant the issue lists: where it is, the function it's in (none at a
// file's top level outside any declaration), and the change it made.
export type Finding = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly id: string;
  readonly scope: Option.Option<string>;
  readonly mutator: string;
  readonly original: string;
  readonly replacement: string;
  readonly covered: boolean;
};

export type Findings = {
  readonly survivors: ReadonlyArray<Finding>;
  readonly unverified: ReadonlyArray<Finding>;
};

// What a mutant's status makes it here. A Timeout on a mutant that isn't
// static is a kill: a loop that never ends. Ignored ones, marked with
// `Stryker disable` or by an ignorer, are left out with the killed.
type Kind = "survived" | "uncovered" | "unverified" | "detected";

const kindOf = (mutant: Mutant): Kind => {
  if (mutant.status === "Survived") {
    return "survived";
  }

  if (mutant.status === "NoCoverage") {
    return "uncovered";
  }

  if (mutant.status === "Timeout" && mutant.static === true) {
    return "unverified";
  }

  return "detected";
};

// Where each line of a source starts, as an offset.
const lineStarts = (source: string) => {
  const starts = [0];

  for (let at = source.indexOf("\n"); at >= 0; at = source.indexOf("\n", at + 1)) {
    starts.push(at + 1);
  }

  return starts;
};

// Stryker's lines and columns both count from 1.
const offsetOf = (starts: ReadonlyArray<number>, position: typeof Position.Type) =>
  Option.getOrElse(Arr.get(starts, position.line - 1), () => 0) + position.column - 1;

const isFunction = (node: Option.Option<ts.Node>) =>
  Option.exists(node, (found) => ts.isArrowFunction(found) || ts.isFunctionExpression(found));

const topLevel = (declaration: ts.VariableDeclaration) =>
  ts.isSourceFile(declaration.parent.parent.parent);

// The name a node gives the code inside it: a function, a method, a class,
// a property or variable holding a function, or any declaration at a file's
// top level, such as a schema.
const nameOf = (source: ts.SourceFile, node: ts.Node): Option.Option<string> => {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    return Option.map(Option.fromUndefinedOr(node.name), (name) => name.text);
  }

  if (ts.isConstructorDeclaration(node)) {
    return Option.some("constructor");
  }

  if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    return Option.some(node.name.getText(source));
  }

  if (
    ts.isVariableDeclaration(node) &&
    (topLevel(node) || isFunction(Option.fromUndefinedOr(node.initializer)))
  ) {
    return Option.some(node.name.getText(source));
  }

  if (
    (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) &&
    isFunction(Option.fromUndefinedOr(node.initializer))
  ) {
    return Option.some(node.name.getText(source));
  }

  return Option.none();
};

// The names around an offset, outermost first.
const scopesAt = (source: ts.SourceFile, node: ts.Node, offset: number): ReadonlyArray<string> =>
  Arr.appendAll(
    Option.toArray(nameOf(source, node)),
    Option.match(
      Arr.findFirst(
        node.getChildren(source),
        (child) => child.getStart(source) <= offset && offset < child.getEnd(),
      ),
      {
        onNone: () => [],
        onSome: (child) => scopesAt(source, child, offset),
      },
    ),
  );

const byPlace = Order.combineAll([
  Order.mapInput(Order.String, (finding: Finding) => finding.file),
  Order.mapInput(Order.Number, (finding: Finding) => finding.line),
  Order.mapInput(Order.Number, (finding: Finding) => finding.column),
  Order.mapInput(Order.Number, (finding: Finding) => Number(finding.id)),
]);

// The survivors and the unverified Timeouts in a report, each in file order.
export const findingsOf = (report: MutationReport): Findings => {
  const found = Object.entries(report.files).flatMap(([file, { mutants, source }]) => {
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const starts = lineStarts(source);

    return mutants.flatMap((mutant) => {
      const start = offsetOf(starts, mutant.location.start);
      const kind = kindOf(mutant);

      const finding: Finding = {
        file,
        line: mutant.location.start.line,
        column: mutant.location.start.column,
        id: mutant.id,
        scope: Option.liftPredicate(
          scopesAt(parsed, parsed, start).join("."),
          (name) => name !== "",
        ),
        mutator: mutant.mutatorName,
        original: source.slice(start, offsetOf(starts, mutant.location.end)),
        replacement: mutant.replacement ?? "",
        covered: kind !== "uncovered",
      };

      return Bool.match(kind === "detected", {
        onTrue: () => [],
        onFalse: () => [{ kind, finding }],
      });
    });
  });

  const of = (kinds: ReadonlyArray<Kind>) =>
    Arr.sort(
      found.filter(({ kind }) => kinds.includes(kind)).map(({ finding }) => finding),
      byPlace,
    );

  return { survivors: of(["survived", "uncovered"]), unverified: of(["unverified"]) };
};

const MAX_TEXT = 80;

// Code as the issue shows it: its first line, and at most MAX_TEXT characters.
const shorten = (text: string) => {
  const lines = text.split("\n");
  const first = Option.getOrElse(Arr.head(lines), () => "").trim();

  const shown = Bool.match(lines.length > 1, {
    onTrue: () => `${first} …`,
    onFalse: () => first,
  });

  return Bool.match(shown.length > MAX_TEXT, {
    onTrue: () => `${shown.slice(0, MAX_TEXT - 1)}…`,
    onFalse: () => shown,
  });
};

// A code span that holds any backticks the text has.
const code = (text: string) => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);

  const padding = Bool.match(/^`|`$/.test(text), {
    onTrue: () => " ",
    onFalse: () => "",
  });

  return `${fence}${padding}${text}${padding}${fence}`;
};

const plural = (count: number, noun: string) =>
  Bool.match(count === 1, {
    onTrue: () => `${count} ${noun}`,
    onFalse: () => `${count} ${noun}s`,
  });

const item = (finding: Finding) => {
  const coverage = Bool.match(finding.covered, {
    onTrue: () => "",
    onFalse: () => ", no coverage",
  });

  return `- ${code(`${finding.file}:${finding.line}`)} ${finding.mutator}${coverage}: ${code(shorten(finding.original))} → ${code(shorten(finding.replacement))}`;
};

// The findings under a heading for each function, in the order they first appear.
const grouped = (findings: ReadonlyArray<Finding>) => {
  const groups = new Map<string, { heading: string; items: Array<string> }>();

  for (const finding of findings) {
    const heading = Option.match(finding.scope, {
      onNone: () => `### The top level of ${code(finding.file)}`,
      onSome: (scope) => `### ${code(scope)} in ${code(finding.file)}`,
    });

    const group = groups.get(heading) ?? { heading, items: [] };
    group.items.push(item(finding));
    groups.set(heading, group);
  }

  return [...groups.values()].map((group) => `${group.heading}\n\n${group.items.join("\n")}`);
};

// The hidden marker a module's issue carries, so the next run finds it.
export const markerOf = (module: string) => `<!-- chernabog-mutation ${printJson({ module })} -->`;

const Marked = Schema.fromJsonString(Schema.Struct({ module: Schema.String }));

// The module an issue's marker names, if it has one.
export const markedModule = (body: string) =>
  Option.flatMap(
    Option.fromNullishOr(/<!-- chernabog-mutation (\{.*?\}) -->/.exec(body)),
    (match) =>
      Option.map(
        Option.flatMap(Option.fromUndefinedOr(match[1]), Schema.decodeOption(Marked)),
        (marked) => marked.module,
      ),
  );

export type Issue = { readonly title: string; readonly body: string };

export const titleOf = (module: string) => `Surviving mutants in ${module}`;

// The module's issue for its findings, or none when there's nothing to do.
export const renderIssue = (
  module: string,
  findings: Findings,
  runUrl: Option.Option<string>,
): Option.Option<Issue> => {
  const { survivors, unverified } = findings;

  if (survivors.length === 0 && unverified.length === 0) {
    return Option.none();
  }

  const timeouts = plural(unverified.length, "static mutant");

  const opening = Bool.match(survivors.length === 0, {
    onTrue: () => [
      `Mutation testing of ${code(module)} leaves no mutant alive, but ${timeouts} timed out, which is unverified: see the last section.`,
    ],
    onFalse: () => [
      `Mutation testing of ${code(module)} leaves ${plural(survivors.length, "mutant")} alive: changes to its code that no test notices. Each one marks a test that doesn't pin down the behaviour it covers. They're grouped by function, since one missing test often explains several.`,
      ...Bool.match(unverified.length === 0, {
        onTrue: () => [],
        onFalse: () => [
          `${timeouts} timed out as well, which is unverified: see the last section.`,
        ],
      }),
    ],
  });

  const local = `run ${code(`bun run mutation ${module}`)} and open ${code(`reports/mutation/${module}/mutation.html`)}`;

  const report = Option.match(runUrl, {
    onNone: () => `To see the HTML report, ${local}.`,
    onSome: (url) =>
      `The HTML report is in the ${code(`mutation-${module}`)} artifact of [the run](${url}). To see it locally, ${local}.`,
  });

  const survived = Bool.match(survivors.length === 0, {
    onTrue: () => [],
    onFalse: () => ["## Survivors", ...grouped(survivors)],
  });

  const unchecked = Bool.match(unverified.length === 0, {
    onTrue: () => [],
    onFalse: () => [
      "## Unverified timeouts",
      `A static mutant runs the module's whole test selection, so a Timeout on one can come from a slow test under load rather than a loop that never ends (docs/testing/mutation-spike.md). Run these again with a longer ${code("timeoutMS")} to tell.`,
      ...grouped(unverified),
    ],
  });

  const footer = `${code("scripts/mutation-issues.ts")} rewrites this body after each nightly run. Kill a survivor with a test that fails on the mutated code, written against the behaviour; mark an equivalent one ${code("// Stryker disable next-line <mutator>: <reason>")}.`;

  const sections = [...opening, report, ...survived, ...unchecked, "---", footer];

  return Option.some({
    title: titleOf(module),
    body: `${markerOf(module)}\n${sections.join("\n\n")}\n`,
  });
};

// The comment on a module's issue as it closes.
export const closingComment = (module: string, runUrl: Option.Option<string>) => {
  const asOf = Option.match(runUrl, {
    onNone: () => "",
    onSome: (url) => ` as of [this run](${url})`,
  });

  return `Mutation testing of ${code(module)} leaves no mutant alive${asOf}, so this is done.`;
};

export type Open = { readonly number: number; readonly title: string; readonly body: string };

// What to do with a module's issue.
export type Action = Data.TaggedEnum<{
  Create: { readonly issue: Issue };
  Update: { readonly number: number; readonly issue: Issue };
  Unchanged: { readonly number: number };
  Close: { readonly number: number; readonly comment: string };
  Nothing: Record<never, never>;
}>;

export const Action = Data.taggedEnum<Action>();

// What a run does, from the module's open issue, if any, and the one its
// report gives, if any.
export const actionFor = (
  open: Option.Option<Open>,
  issue: Option.Option<Issue>,
  comment: string,
): Action =>
  Option.match(open, {
    onNone: () =>
      Option.match(issue, {
        onNone: () => Action.Nothing(),
        onSome: (rendered) => Action.Create({ issue: rendered }),
      }),
    onSome: (found) =>
      Option.match(issue, {
        onNone: () => Action.Close({ number: found.number, comment }),
        onSome: (rendered) =>
          Bool.match(rendered.title === found.title && rendered.body === found.body, {
            onTrue: () => Action.Unchanged({ number: found.number }),
            onFalse: () => Action.Update({ number: found.number, issue: rendered }),
          }),
      }),
  });
