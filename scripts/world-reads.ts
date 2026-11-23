// The world is input, never record (ADR 21, epic #557): no source in the SDK
// or a recipe reads progress back from what chernabog wrote on GitHub. Two
// kinds of read give one away, and this finds both in a file's source:
//
// - a status label read, anything in the projector's table
//   (StatusLabels.statusOf): a label name tested with `includes`,
//   `indexOf`, `===` or `!==`, or listed with `issuesLabelled` or
//   `pullRequestsLabelled`;
// - `.read` on one of chernabog's comment markers, but the ones that only
//   link objects or deduplicate a write: planNodeMarker, followUpMarker and
//   the epic status comment's own statusMarker.
//
// Backfill is the one place inference from the world is allowed, and the
// projector derives the labels it writes, so both files are exempt; so is
// the hand-back observer, which reads a person's removal of the needs-human
// label as their intent (ADR 21, decision 1). `bun run lint:architecture`
// runs it (check-world-reads.ts) over packages/sdk/src and packages/recipes.

import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import ts from "typescript";

// The markers whose reads link objects or deduplicate a write, and say
// nothing of progress.
export const LINKING_MARKERS: ReadonlyArray<string> = [
  "planNodeMarker",
  "followUpMarker",
  "statusMarker",
];

// The files allowed to read the world back, repo-relative.
export const EXEMPT_FILES: ReadonlyArray<string> = [
  // Infers a record for an item that has none, once (ADR 21; audit, "Backfill").
  "packages/sdk/src/backfill.ts",
  // The projector: Labels.project and the sync that writes its labels.
  "packages/sdk/src/status-labels.ts",
];

// Top-level declarations allowed to read the world back, by file.
export const EXEMPT_DECLARATIONS: ReadonlyArray<{
  readonly file: string;
  readonly name: string;
}> = [
  // The hand-back observer: a trusted person taking auto:needs-human off is
  // their intent to hand the item back (ADR 21, decision 1).
  { file: "packages/sdk/src/phases.ts", name: "handedBack" },
  // Backfill's reader of the merge-hold marker, beside the marker it reads:
  // only backfill calls it, and PullRequest exports it.
  { file: "packages/sdk/src/pull-request.ts", name: "holdKeysOf" },
];

// The status labels, as StatusLabels.statusOf names them with the default
// names, and as the SDK's constants and settings name them.
const STATUS_LABELS = [
  "auto:in-progress",
  "auto:needs-review",
  "auto:changes-requested",
  "auto:approved",
  "auto:needs-human",
  "auto:needs-clarification",
  "auto:stale",
  "auto:ready-for-person",
  "auto:awaiting-ready",
  "auto:adopted",
  "auto:plan-proposed",
];

// A label name's key in the flow's label names (Settings.LabelNames), or
// readyForPerson; `approved` too, which is a status label there.
const STATUS_KEYS = [
  "inProgress",
  "needsReview",
  "changesRequested",
  "approved",
  "needsHuman",
  "needsClarification",
  "stale",
  "readyForPerson",
];

// What holds the flow's label names reads as one of these.
const LABEL_NAMES = /label|name/i;

// The constants that hold a status label.
const STATUS_CONSTANTS = [
  "AWAITING_READY",
  "AWAITING_READY_LABEL",
  "ADOPTED",
  "ADOPTED_LABEL",
  "READY_FOR_PERSON",
];

// The plan's labels (plan-labels.ts), of which only `proposed` is a status
// label: plan, approved and epic are a person's intent.
const PLAN_LABELS = ["LABELS", "PLAN_LABELS"];

// The calls that test or list by a label.
const TESTS = ["includes", "indexOf"];
const LISTS = ["issuesLabelled", "pullRequestsLabelled"];

export type WorldRead = {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly why: string;
};

// The repo's root, which the files' repo-relative paths start from.
export const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const isPlanLabels = (node: ts.Expression) =>
  (ts.isIdentifier(node) && PLAN_LABELS.includes(node.text)) ||
  (ts.isPropertyAccessExpression(node) && PLAN_LABELS.includes(node.name.text));

// Whether `node`, a property access, names a status label: `proposed` of
// the plan's labels, a constant, or a key of the label names on what holds
// them (labels, labelNames, named, DEFAULT_LABELS): a phase's `approved` is
// no label.
const namesStatusKey = (node: ts.PropertyAccessExpression) => {
  const key = node.name.text;

  if (isPlanLabels(node.expression)) {
    return key === "proposed";
  }

  return (
    STATUS_CONSTANTS.includes(key) ||
    (STATUS_KEYS.includes(key) && LABEL_NAMES.test(node.expression.getText()))
  );
};

// Whether `node` names a status label.
const namesStatus = (node: ts.Expression): boolean => {
  if (ts.isParenthesizedExpression(node)) {
    return namesStatus(node.expression);
  }

  if (ts.isStringLiteralLike(node)) {
    return STATUS_LABELS.includes(node.text);
  }

  if (ts.isIdentifier(node)) {
    return STATUS_CONSTANTS.includes(node.text);
  }

  return ts.isPropertyAccessExpression(node) && namesStatusKey(node);
};

const calledName = (call: ts.CallExpression) => {
  const callee = call.expression;

  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }

  return Option.getOrElse(
    Option.map(Option.liftPredicate(callee, ts.isIdentifier), (named) => named.text),
    () => "",
  );
};

const COMPARISONS = [
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
];

const LABEL_READ = "reads a status label, which is the ledger's projection: read the item's record";

// Why `node` reads the world back, if it does.
const readOf = (node: ts.Node): Option.Option<string> => {
  if (
    ts.isCallExpression(node) &&
    [...TESTS, ...LISTS].includes(calledName(node)) &&
    node.arguments.some(namesStatus)
  ) {
    return Option.some(LABEL_READ);
  }

  if (
    ts.isBinaryExpression(node) &&
    COMPARISONS.includes(node.operatorToken.kind) &&
    (namesStatus(node.left) || namesStatus(node.right))
  ) {
    return Option.some(
      "compares with a status label, which is the ledger's projection: read the item's record",
    );
  }

  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "read" &&
    ts.isIdentifier(node.expression) &&
    node.expression.text.endsWith("Marker") &&
    !LINKING_MARKERS.includes(node.expression.text)
  ) {
    return Option.some(
      `reads ${node.expression.text}, chernabog's own comment, back as a record: what it did is in the item's record`,
    );
  }

  return Option.none();
};

// The names a top-level statement declares.
const declaredBy = (statement: ts.Node): ReadonlyArray<string> => {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      Option.toArray(
        Option.map(Option.liftPredicate(declaration.name, ts.isIdentifier), (name) => name.text),
      ),
    );
  }

  if (ts.isFunctionDeclaration(statement)) {
    return Option.toArray(Option.map(Option.fromUndefinedOr(statement.name), (name) => name.text));
  }

  return [];
};

// The names the top-level statement `node` is in declares.
const declarationsOf = (node: ts.Node) => {
  let current = node;

  while (!ts.isSourceFile(current.parent)) {
    current = current.parent;
  }

  return declaredBy(current);
};

const exempted = (file: string, node: ts.Node) =>
  EXEMPT_DECLARATIONS.some(
    (exempt) => exempt.file === file && declarationsOf(node).includes(exempt.name),
  );

// Every read of the world back as a record in `source`, the text of the
// repo-relative `file`.
export const worldReads = (file: string, source: string): ReadonlyArray<WorldRead> => {
  if (EXEMPT_FILES.includes(file)) {
    return [];
  }

  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: Array<WorldRead> = [];

  const visit = (node: ts.Node) => {
    for (const why of Option.toArray(readOf(node))) {
      if (!exempted(file, node)) {
        found.push({
          file,
          line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
          text: node.getText(parsed),
          why,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(parsed);

  return found;
};

// Whether `file`, repo-relative, is one the rule holds: the SDK's sources
// and the recipes, not their tests or installed packages.
export const inScope = (file: string) =>
  (file.startsWith("packages/sdk/src/") || file.startsWith("packages/recipes/")) &&
  file.endsWith(".ts") &&
  !file.endsWith(".test.ts") &&
  !file.includes("/node_modules/");

// Every read in the files the rule holds, under the repo at `root`.
export const treeReads = (root: string = repoRoot) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const found: Array<WorldRead> = [];

    for (const directory of ["packages/sdk/src", "packages/recipes"]) {
      const entries = yield* fs.readDirectory(`${root}${directory}`, { recursive: true });

      for (const file of entries.map((entry) => `${directory}/${entry}`).filter(inScope)) {
        for (const read of worldReads(file, yield* fs.readFileString(`${root}${file}`))) {
          found.push(read);
        }
      }
    }

    return found;
  });

// What `bun run lint:architecture` prints for a read.
export const describeRead = (read: WorldRead) =>
  `${read.file}:${read.line}: ${read.text}: ${read.why}`;
