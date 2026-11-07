// Flow documents: a flow as data, which compiles to an ordinary flow file, so
// the engine, a rehearsal and `tsc` see nothing new. Every value a step takes
// names the step it came from, so nothing accumulates: remove a step, and what
// used it no longer compiles. Branches are on what a block declares it can come
// to, and there are no expressions.
//
// Experimental: this and blocks.ts cover implement and review, and their shape
// may change until they cover more of the recipes.
//
// `read` takes a document's shape, `check` what can be said of it without a
// compiler, with where in the document it is. Whether each wire's type fits is
// left to `tsc` on what `generate` writes.

import { printJson } from "@chernabog/core";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { catalogue, sources, subjects } from "./blocks.ts";

export type Problem = { readonly path: string; readonly message: string };

export type EndStep =
  | { readonly end: "done"; readonly summary?: string }
  | { readonly end: "needs-human"; readonly reason: string };

export type Branch = { readonly as?: string; readonly steps: ReadonlyArray<Step> };

export type UseStep = {
  readonly id: string;
  readonly use: string;
  readonly in?: { readonly [input: string]: string };
  readonly with?: { readonly [input: string]: Schema.Json };
  readonly failure?: { readonly [tag: string]: Schema.Json };
  readonly on?: { readonly [outcome: string]: Branch };
};

export type Step = UseStep | EndStep;

const EndStep = Schema.Union([
  Schema.Struct({ end: Schema.Literal("done"), summary: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ end: Schema.Literal("needs-human"), reason: Schema.String }),
]);

const Step: Schema.Codec<Step> = Schema.Union([
  EndStep,
  Schema.Struct({
    id: Schema.String,
    use: Schema.String,
    in: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    failure: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    on: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.Struct({
          as: Schema.optionalKey(Schema.String),
          steps: Schema.Array(Schema.suspend((): Schema.Codec<Step> => Step)),
        }),
      ),
    ),
  }),
]);

export const FlowDocument = Schema.Struct({
  flow: Schema.String,
  subject: Schema.String,
  gate: Schema.optionalKey(Schema.Literal("usage")),
  concurrency: Schema.optionalKey(Schema.Int),
  trigger: Schema.Array(
    Schema.Struct({
      use: Schema.String,
      with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    }),
  ),
  // What each scope keeps for a failure to tell a person, and the outputs that set it.
  failureContext: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  steps: Schema.Array(Step),
});

export type FlowDocument = typeof FlowDocument.Type;

// A document's shape: whatever a parser made of its text, or why it isn't one.
export const read = Schema.decodeUnknownResult(FlowDocument);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

// As a flow's name is anywhere else.
const FLOW_NAME = /^[a-z0-9][\w.-]*$/;

// The names a generated flow uses itself.
const RESERVED = new Set([
  "Blocks",
  "Effect",
  "NeedsHuman",
  "Option",
  "assemble",
  "catalogue",
  "failureContext",
  "item",
  "sources",
  "subjects",
  "trigger",
]);

// A list as a sentence names it, or "nothing" for an empty one.
const listed = (names: ReadonlyArray<string>, nothing: string) =>
  Option.getOrElse(
    Option.liftPredicate(names.join(", "), () => names.length > 0),
    () => nothing,
  );

export const isEnd = (step: Step): step is EndStep => "end" in step;

const rootOf = (reference: string) => reference.split(".")[0];

const branchesOf = (step: UseStep) => Object.entries(step.on ?? {});

const declaredIn = (steps: ReadonlyArray<Step>): ReadonlyArray<string> =>
  steps.flatMap((step) => {
    if (isEnd(step)) {
      return [];
    }

    return [
      step.id,
      ...branchesOf(step).flatMap(([, branch]) => [
        ...Option.toArray(Option.fromUndefinedOr(branch.as)),
        ...declaredIn(branch.steps),
      ]),
    ];
  });

const usedIn = (steps: ReadonlyArray<Step>): ReadonlyArray<string> =>
  steps.flatMap((step) => {
    if (isEnd(step)) {
      return [];
    }

    return [step.use, ...branchesOf(step).flatMap(([, branch]) => usedIn(branch.steps))];
  });

// What a check of one document keeps as it walks.
type Checking = {
  readonly problems: Array<Problem>;
  readonly subject: string;
  readonly fields: ReadonlyArray<string>;
};

type Block = (typeof catalogue)[keyof typeof catalogue];

type Subject = (typeof subjects)[keyof typeof subjects];

const blocksByName: { readonly [name: string]: Block } = catalogue;

const subjectsByName: { readonly [name: string]: Subject } = subjects;

const sourcesByName: { readonly [name: string]: { readonly subject: string } } = sources;

const say = (checking: Checking, path: string, message: string) => {
  checking.problems.push({ path, message });
};

const checkReference = (
  checking: Checking,
  names: ReadonlySet<string>,
  reference: string,
  at: string,
) => {
  if (!REFERENCE.test(reference)) {
    say(checking, at, "must name an earlier step's output, as step.field");

    return;
  }

  const root = rootOf(reference);

  if (!names.has(root)) {
    say(checking, at, `${root} is not available here; there are ${[...names].join(", ")}`);

    return;
  }

  const field = reference.split(".")[1] ?? "";

  if (root === "trigger" && !checking.fields.includes(field)) {
    say(
      checking,
      at,
      `the trigger of a flow on ${checking.subject} gives ${checking.fields.join(", ")}`,
    );
  }
};

const checkInputs = (
  checking: Checking,
  step: UseStep,
  block: Block,
  names: ReadonlySet<string>,
  at: string,
) => {
  const wired = step.in ?? {};
  const given = step.with ?? {};
  const takes = Object.keys(block.inputs).join(", ");

  for (const [input, need] of Object.entries(block.inputs)) {
    if (need === "required" && !(input in wired) && !(input in given)) {
      say(checking, `${at}.in`, `${step.use} needs ${input}`);
    }
  }

  for (const [input, reference] of Object.entries(wired)) {
    if (!(input in block.inputs)) {
      say(checking, `${at}.in.${input}`, `${step.use} takes ${takes}`);
    }

    checkReference(checking, names, reference, `${at}.in.${input}`);
  }

  for (const input of Object.keys(given)) {
    if (!(input in block.inputs)) {
      say(checking, `${at}.with.${input}`, `${step.use} takes ${takes}`);
    }
  }
};

const checkIdentity = (
  checking: Checking,
  step: UseStep,
  block: Block,
  names: ReadonlySet<string>,
  used: Used,
  at: string,
) => {
  if (!IDENTIFIER.test(step.id) || RESERVED.has(step.id)) {
    say(checking, `${at}.id`, `${step.id} can't name a step`);
  }

  if (names.has(step.id)) {
    say(checking, `${at}.id`, `${step.id} is already a step here`);
  }

  // A run resumes by its step names, which a block's two uses would share, as
  // would two blocks that use the same ones.
  const earlier = block.stepNames.flatMap((name) =>
    Option.toArray(Option.fromUndefinedOr(used.get(name))),
  );

  for (const use of earlier.slice(0, 1)) {
    if (use === step.use) {
      say(checking, `${at}.use`, `${use} runs twice on one path, and its step names would collide`);
    } else {
      say(
        checking,
        `${at}.use`,
        `${step.use} runs on one path with ${use}, and their step names would collide`,
      );
    }
  }
};

// What a branch calls its outcome's value is a name in the flow, as a step's id is.
const checkBinding = (
  checking: Checking,
  branch: Branch,
  names: ReadonlySet<string>,
  at: string,
) => {
  for (const name of Option.toArray(Option.fromUndefinedOr(branch.as))) {
    if (!IDENTIFIER.test(name) || RESERVED.has(name)) {
      say(checking, at, `${name} can't name what a branch binds`);
    } else if (names.has(name)) {
      say(checking, at, `${name} is already a step here`);
    }
  }
};

const checkRouting = (checking: Checking, step: UseStep, block: Block, at: string) => {
  const routed = step.on ?? {};
  const outcomes = Object.keys(block.outcomes);

  for (const outcome of block.mustRoute) {
    if (!(outcome in routed)) {
      say(
        checking,
        `${at}.on`,
        `${step.use} can come to ${outcome}, and this doesn't say what then`,
      );
    }
  }

  for (const outcome of Object.keys(routed)) {
    if (!outcomes.includes(outcome)) {
      say(
        checking,
        `${at}.on.${outcome}`,
        `${step.use} comes to ${listed(outcomes, "nothing to route")}`,
      );
    }
  }
};

// Each group of step names a path has used, and the block that used it.
type Used = ReadonlyMap<string, string>;

type Walked = { readonly ends: boolean; readonly seen: Used };

// Walks the steps as a run goes through them, with the names it has at each
// and the blocks it has used.
const checkSteps = (
  checking: Checking,
  steps: ReadonlyArray<Step>,
  path: string,
  scope: ReadonlySet<string>,
  seen: Used,
): Walked => {
  const names = new Set(scope);
  const used = new Map(seen);

  const unreachableAfter = (index: number) => {
    if (index < steps.length - 1) {
      say(checking, `${path}[${index + 1}]`, "no run can reach this step");
    }
  };

  for (const [index, step] of steps.entries()) {
    const at = `${path}[${index}]`;

    if (isEnd(step)) {
      if (step.end === "needs-human") {
        checkReference(checking, names, step.reason, `${at}.reason`);
      } else {
        for (const summary of Option.toArray(Option.fromUndefinedOr(step.summary))) {
          checkReference(checking, names, summary, `${at}.summary`);
        }
      }

      unreachableAfter(index);

      return { ends: true, seen: used };
    }

    const found = Record.get(blocksByName, step.use);

    if (Option.isNone(found)) {
      say(
        checking,
        `${at}.use`,
        `no block named ${step.use}; there are ${Object.keys(catalogue).join(", ")}`,
      );

      continue;
    }

    const block = found.value;

    checkIdentity(checking, step, block, names, used, at);

    for (const name of block.stepNames) {
      used.set(name, step.use);
    }

    checkInputs(checking, step, block, names, at);
    checkRouting(checking, step, block, at);
    names.add(step.id);

    const walked = branchesOf(step).map(([outcome, branch]) => {
      checkBinding(checking, branch, names, `${at}.on.${outcome}.as`);

      const inBranch = new Set([...names, ...Option.toArray(Option.fromUndefinedOr(branch.as))]);

      return checkSteps(checking, branch.steps, `${at}.on.${outcome}.steps`, inBranch, used);
    });

    // A branch that doesn't end carries on into what follows, with what it used.
    for (const [name, use] of walked.filter((branch) => !branch.ends).flatMap((b) => [...b.seen])) {
      used.set(name, use);
    }

    const covered =
      block.exhaustive && Object.keys(block.outcomes).every((key) => key in (step.on ?? {}));

    if (covered && walked.every((branch) => branch.ends)) {
      unreachableAfter(index);

      return { ends: true, seen: used };
    }
  }

  return { ends: false, seen: used };
};

const checkFailureContext = (
  checking: Checking,
  document: FlowDocument,
  known: ReadonlyArray<string>,
) => {
  const declared = new Set(declaredIn(document.steps));

  for (const [field, references] of Object.entries(document.failureContext ?? {})) {
    if (!known.includes(field)) {
      say(
        checking,
        `failureContext.${field}`,
        `a flow on ${document.subject} keeps ${listed(known, "nothing")} for its failures`,
      );
    }

    for (const reference of references) {
      if (!REFERENCE.test(reference)) {
        say(checking, `failureContext.${field}`, "must name a step's output, as step.field");
      } else if (!declared.has(rootOf(reference))) {
        say(checking, `failureContext.${field}`, `no step named ${rootOf(reference)} sets it`);
      }
    }
  }
};

const checkTrigger = (checking: Checking, document: FlowDocument) => {
  if (document.trigger.length === 0) {
    say(checking, "trigger", "must name where the flow's work comes from");
  }

  for (const [index, source] of document.trigger.entries()) {
    const at = `trigger[${index}].use`;

    const found = Record.get(sourcesByName, source.use);

    if (Option.isNone(found)) {
      say(checking, at, `must be one of ${Object.keys(sources).join(", ")}`);
    } else if (found.value.subject !== document.subject) {
      // Every item it found would fail on reading it, with nobody told.
      say(
        checking,
        at,
        `${source.use} finds work on ${found.value.subject}, and this is a flow on ${document.subject}`,
      );
    }
  }
};

// What is wrong with a document, short of what only its types can say.
export const check = (document: FlowDocument): ReadonlyArray<Problem> => {
  const subject = Record.get(subjectsByName, document.subject);

  if (Option.isNone(subject)) {
    return [{ path: "subject", message: `must be one of ${Object.keys(subjects).join(", ")}` }];
  }

  const checking: Checking = {
    problems: [],
    subject: document.subject,
    fields: subject.value.fields,
  };

  if (!FLOW_NAME.test(document.flow)) {
    say(checking, "flow", "must be a flow name");
  }

  checkTrigger(checking, document);
  checkSteps(checking, document.steps, "steps", new Set(["trigger"]), new Map());
  checkFailureContext(checking, document, subject.value.failureContext);

  return checking.problems;
};

const emitObject = (entries: ReadonlyArray<readonly [string, string]>) =>
  `{ ${entries.map(([key, code]) => `${printJson(key)}: ${code}`).join(", ")} }`;

const emitRemembered = (document: FlowDocument, name: string, indent: string) =>
  Object.entries(document.failureContext ?? {}).flatMap(([field, references]) =>
    references
      .filter((reference) => rootOf(reference) === name)
      .map((reference) => `${indent}failureContext.${field} = Option.some(${reference});`),
  );

const emitEnd = (step: EndStep, indent: string) => {
  if (step.end === "needs-human") {
    return `${indent}return yield* new NeedsHuman({ reason: ${step.reason} });`;
  }

  return `${indent}return ${step.summary ?? "void 0"};`;
};

const emitBranch = (
  document: FlowDocument,
  step: UseStep,
  outcome: string,
  branch: Branch,
  indent: string,
  body: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const taken = `${step.id}_${outcome.replaceAll(/\W/g, "_")}`;

  const bound = Option.toArray(Option.fromUndefinedOr(branch.as)).flatMap((name) => [
    `${indent}  const ${name} = ${taken}.value;`,
    ...emitRemembered(document, name, `${indent}  `),
  ]);

  return [
    `${indent}const ${taken} = catalogue[${printJson(step.use)}].outcomes[${printJson(outcome)}](${step.id});`,
    `${indent}if (Option.isSome(${taken})) {`,
    ...bound,
    ...body,
    `${indent}}`,
  ];
};

const emitSteps = (
  document: FlowDocument,
  steps: ReadonlyArray<Step>,
  indent: string,
): ReadonlyArray<string> =>
  steps.flatMap((step) => {
    if (isEnd(step)) {
      return [emitEnd(step, indent)];
    }

    const input = emitObject([
      ...Object.entries(step.in ?? {}),
      ...Object.entries(step.with ?? {}).map(([key, value]) => [key, printJson(value)] as const),
    ]);

    const overrides = Option.match(Option.fromUndefinedOr(step.failure), {
      onNone: () => "",
      onSome: (failure) => `, ${printJson(failure)}`,
    });

    return [
      `${indent}const ${step.id} = yield* catalogue[${printJson(step.use)}].run(${input}${overrides});`,
      ...emitRemembered(document, step.id, indent),
      ...branchesOf(step).flatMap(([outcome, branch]) =>
        emitBranch(
          document,
          step,
          outcome,
          branch,
          indent,
          emitSteps(document, branch.steps, `${indent}  `),
        ),
      ),
    ];
  });

const emitSource = (source: FlowDocument["trigger"][number]) => {
  const input = Option.match(Option.fromUndefinedOr(source.with), {
    onNone: () => "",
    onSome: printJson,
  });

  return `sources[${printJson(source.use)}].find(${input})`;
};

const emit = (document: FlowDocument, sdk: string) => {
  const blocks = [...new Set(usedIn(document.steps))];
  const subject = `subjects[${printJson(document.subject)}]`;

  return [
    `// Generated from the flow document ${document.flow}; change the document, not this file.`,
    `import { Blocks, NeedsHuman } from ${printJson(sdk)};`,
    `import * as Effect from "effect/Effect";`,
    `import * as Option from "effect/Option";`,
    "",
    "const { assemble, catalogue, sources, subjects } = Blocks;",
    "",
    "export default assemble({",
    `  subject: ${printJson(document.subject)},`,
    ...Option.toArray(Option.fromUndefinedOr(document.gate)).map(
      (gate) => `  gate: ${printJson(gate)},`,
    ),
    ...Option.toArray(Option.fromUndefinedOr(document.concurrency)).map(
      (concurrency) => `  concurrency: ${concurrency},`,
    ),
    `  sources: [${document.trigger.map(emitSource).join(", ")}],`,
    `  blocks: ${printJson(blocks)},`,
    "  workflow: (item) =>",
    "    Effect.gen(function* () {",
    `      const trigger = yield* ${subject}.read(item);`,
    "",
    `      return yield* ${subject}.scope(trigger, { claims: ${blocks.includes("issue.claim")} }, (failureContext) =>`,
    "        Effect.gen(function* () {",
    ...emitSteps(document, document.steps, "          "),
    "        }),",
    "      );",
    "    }),",
    "});",
    "",
  ].join("\n");
};

// The flow file a document compiles to, or what is wrong with the document.
// `sdk` is where the file imports the SDK from.
export const generate = (document: FlowDocument, sdk = "@chernabog/sdk") => {
  const problems = check(document);

  if (problems.length > 0) {
    return Result.fail(problems);
  }

  return Result.succeed(emit(document, sdk));
};
