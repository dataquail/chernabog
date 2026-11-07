// Flow documents: a flow as data, which compiles to an ordinary flow file, so
// the engine, a rehearsal and `tsc` see nothing new. Every value a step takes
// names the step it came from, so nothing accumulates: remove a step, and what
// used it no longer compiles. Branches are on what a block declares it can come
// to, and there are no expressions.
//
// Experimental: this and the blocks cover implement, review, re-review,
// address-review, resolve-conflicts, post-merge, human-initiated and epic, and
// their shape may change until they cover more of the recipes.
//
// `read` takes a document's shape, `check` what can be said of it without a
// compiler, with where in the document it is. Whether each wire's type fits is
// left to `tsc` on what `generate` writes.

import { printJson } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type * as SchemaIssue from "effect/SchemaIssue";

import {
  catalogue,
  laneScopes,
  loopStates,
  sourceDescriptions,
  sources,
  startOf,
  subjects,
} from "./blocks.ts";

export type Problem = { readonly path: string; readonly message: string };

export type EndStep =
  | { readonly end: "done"; readonly summary?: string }
  | { readonly end: "needs-human"; readonly reason: string };

export type Branch = { readonly as?: string; readonly steps: ReadonlyArray<Step> };

export type UseStep = {
  readonly id: string;
  readonly use: string;
  // Runs only when the named boolean output is true, which `tsc` holds it to. Its output is then
  // optional, and `first` joins it with what stands in for it.
  readonly if?: string;
  readonly in?: { readonly [input: string]: Schema.Json };
  readonly with?: { readonly [input: string]: Schema.Json };
  readonly failure?: { readonly [tag: string]: Schema.Json };
  readonly on?: { readonly [outcome: string]: Branch };
};

// Runs a step of the repo's own, from .chernabog/stages/: an Effect stage, whose
// input and output schemas type its wires as a block's types are. It comes to
// no outcomes, and says what each of its failures means, as a stage has no
// table of its own. Under `in`, `round` and `lane` name its step, as a block's
// do, rather than going into its input.
export type StageStep = {
  readonly id: string;
  readonly stage: string;
  readonly if?: string;
  readonly in?: { readonly [input: string]: Schema.Json };
  readonly with?: { readonly [input: string]: Schema.Json };
  readonly failure?: { readonly [tag: string]: Schema.Json };
  readonly on?: { readonly [outcome: string]: Branch };
};

// Runs its steps over and over, each round with `round` and the `state` as the
// last `next` left it, until one of them ends.
export type RepeatStep = {
  readonly id: string;
  readonly repeat: {
    readonly state: { readonly [name: string]: string };
    readonly steps: ReadonlyArray<Step>;
  };
};

// Goes on to the next round, with what changed of the state.
export type NextStep = { readonly next: { readonly [name: string]: string } };

// Runs its steps once for each item, as lines of work beside each other, `as`
// naming the item. Each ends for itself, in `scope`, and its output is how
// each one ended.
export type ForEachStep = {
  readonly id: string;
  readonly forEach: string;
  readonly as: string;
  readonly scope: string;
  readonly atOnce: string;
  readonly failureContext?: { readonly [field: string]: ReadonlyArray<string> };
  readonly steps: ReadonlyArray<Step>;
};

// The first of these that ran: a conditional step's output, or what stands in for it.
export type FirstStep = { readonly id: string; readonly first: ReadonlyArray<string> };

export type Step = UseStep | StageStep | EndStep | RepeatStep | NextStep | ForEachStep | FirstStep;

const EndStep = Schema.Union([
  Schema.Struct({ end: Schema.Literal("done"), summary: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ end: Schema.Literal("needs-human"), reason: Schema.String }),
]);

const Steps = Schema.Array(Schema.suspend((): Schema.Codec<Step> => Step));

const Branches = Schema.Record(
  Schema.String,
  Schema.Struct({
    as: Schema.optionalKey(Schema.String),
    steps: Steps,
  }),
);

const Step: Schema.Codec<Step> = Schema.Union([
  EndStep,
  Schema.Struct({ next: Schema.Record(Schema.String, Schema.String) }),
  Schema.Struct({ id: Schema.String, first: Schema.Array(Schema.String) }),
  Schema.Struct({
    id: Schema.String,
    repeat: Schema.Struct({
      state: Schema.Record(Schema.String, Schema.String),
      steps: Steps,
    }),
  }),
  Schema.Struct({
    id: Schema.String,
    forEach: Schema.String,
    as: Schema.String,
    scope: Schema.String,
    atOnce: Schema.String,
    failureContext: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
    steps: Steps,
  }),
  Schema.Struct({
    id: Schema.String,
    use: Schema.String,
    if: Schema.optionalKey(Schema.String),
    in: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    failure: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    on: Schema.optionalKey(Branches),
  }),
  Schema.Struct({
    id: Schema.String,
    stage: Schema.String,
    if: Schema.optionalKey(Schema.String),
    in: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    failure: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    on: Schema.optionalKey(Branches),
  }),
]);

export const FlowDocument = Schema.Struct({
  flow: Schema.String,
  subject: Schema.String,
  gate: Schema.optionalKey(Schema.Literal("usage")),
  concurrency: Schema.optionalKey(Schema.Int),
  // A flow a person starts, with `chernabog start <issue>`, says so here and
  // has no trigger, which reads as none.
  start: Schema.optionalKey(Schema.Literal(true)),
  trigger: Schema.Array(
    Schema.Struct({
      use: Schema.String,
      with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  // What each scope keeps for a failure to tell a person, and the outputs that set it.
  failureContext: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  steps: Schema.Array(Step),
});

export type FlowDocument = typeof FlowDocument.Type;

type JsonObject = { readonly [key: string]: Schema.Json };

const isObject = (value: Schema.Json): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

const FORMAT_HINT = "chernabog recipes blocks shows the format.";

const TRIGGER_OR_START =
  "name where the flow's work comes from, or say start: true for a flow a person starts with chernabog start <issue>";

const STEP_KINDS =
  "use (a block, with an id), stage (a step of the repo's own, with an id), end, next, first, repeat or forEach";

type StepsAt = (value: Option.Option<Schema.Json>, path: string) => ReadonlyArray<Problem>;

const fieldOf = (object: JsonObject, key: string) => Record.get(object, key);

// The steps nested in a step: its lanes', its rounds' and its branches'.
const nestedProblems = (step: JsonObject, at: string, stepsAt: StepsAt): ReadonlyArray<Problem> => {
  const lanes = Option.match(fieldOf(step, "forEach"), {
    onNone: () => [],
    onSome: () => stepsAt(fieldOf(step, "steps"), `${at}.steps`),
  });

  const rounds = Option.match(Option.filter(fieldOf(step, "repeat"), isObject), {
    onNone: () => [],
    onSome: (repeat) => stepsAt(fieldOf(repeat, "steps"), `${at}.repeat.steps`),
  });

  const branches = Option.match(Option.filter(fieldOf(step, "on"), isObject), {
    onNone: () => [],
    onSome: (on) =>
      Object.entries(on).flatMap(([outcome, branch]): ReadonlyArray<Problem> => {
        if (!isObject(branch)) {
          return [{ path: `${at}.on.${outcome}`, message: "must have steps, and may have as" }];
        }

        return stepsAt(fieldOf(branch, "steps"), `${at}.on.${outcome}.steps`);
      }),
  });

  return [...lanes, ...rounds, ...branches];
};

const stepProblems = (step: JsonObject, at: string, stepsAt: StepsAt): ReadonlyArray<Problem> => {
  const kinds = ["use", "stage", "end", "next", "first", "repeat", "forEach"].filter(
    (key) => key in step,
  );

  if (kinds.length === 0) {
    return [{ path: at, message: `must be a step: ${STEP_KINDS}` }];
  }

  if ("use" in step && "stage" in step) {
    return [{ path: at, message: "uses a block or runs a stage, not both" }];
  }

  if (!("end" in step || "next" in step) && !Predicate.isString(step.id)) {
    return [{ path: at, message: `a ${kinds[0]} step needs an id, which later steps name it by` }];
  }

  return nestedProblems(step, at, stepsAt);
};

const stepsAt: StepsAt = (value, path) => {
  const steps = Option.filter(value, (found) => Array.isArray(found));

  if (Option.isNone(steps) || !Array.isArray(steps.value)) {
    return [{ path, message: "must be a list of steps" }];
  }

  return steps.value.flatMap((step: Schema.Json, index): ReadonlyArray<Problem> => {
    const at = `${path}[${index}]`;

    if (!isObject(step)) {
      return [{ path: at, message: `must be a step: ${STEP_KINDS}` }];
    }

    return stepProblems(step, at, stepsAt);
  });
};

const documentProblems = (value: Schema.Json): ReadonlyArray<Problem> => {
  if (!isObject(value)) {
    return [{ path: "", message: `must be a flow document. ${FORMAT_HINT}` }];
  }

  // A flow a person starts has no trigger.
  const missing = ["flow", "subject", "trigger", "steps"].flatMap((key): ReadonlyArray<Problem> => {
    if (key in value || (key === "trigger" && "start" in value)) {
      return [];
    }

    if (key === "trigger") {
      return [{ path: key, message: `is missing: ${TRIGGER_OR_START}. ${FORMAT_HINT}` }];
    }

    return [{ path: key, message: `is missing. ${FORMAT_HINT}` }];
  });

  return [
    ...missing,
    ...Option.match(fieldOf(value, "steps"), {
      onNone: () => [],
      onSome: (steps) => stepsAt(Option.some(steps), "steps"),
    }),
  ];
};

const pathTo = (keys: ReadonlyArray<PropertyKey>) =>
  keys.reduce<string>((path, key) => {
    if (Predicate.isNumber(key)) {
      return `${path}[${key}]`;
    }

    if (path === "") {
      return String(key);
    }

    return `${path}.${String(key)}`;
  }, "");

// One thing a document's form got wrong, with how far into the document it got.
type Mismatch = {
  readonly keys: ReadonlyArray<PropertyKey>;
  readonly message: string;
  readonly missing: boolean;
};

const saysMoreThan = (each: Mismatch, other: Mismatch) =>
  each.keys.length > other.keys.length ||
  (each.keys.length === other.keys.length && other.missing && !each.missing);

// The one that says the most: the one furthest in, and of those, a value that's
// wrong rather than a key that isn't there.
const furthest = (mismatches: ReadonlyArray<Mismatch>) =>
  mismatches.reduce<Option.Option<Mismatch>>(
    (best, each) =>
      Option.some(
        Option.match(best, {
          onNone: () => each,
          onSome: (other) => {
            if (saysMoreThan(each, other)) {
              return each;
            }

            return other;
          },
        }),
      ),
    Option.none(),
  );

// A step can take several forms, so a mismatch has one account for each. The
// form it got furthest into is the one it was meant to be. When it got no further
// than lacking a key of each, it's none of them, and saying which key would
// send its author after the first form that happened to be listed.
const mismatchOf = (
  issue: SchemaIssue.Issue,
  keys: ReadonlyArray<PropertyKey>,
): Option.Option<Mismatch> => {
  const furthestOf = (issues: ReadonlyArray<SchemaIssue.Issue>) =>
    furthest(issues.flatMap((each) => Option.toArray(mismatchOf(each, keys))));

  return Match.value(issue).pipe(
    Match.tag("Pointer", (pointer) => mismatchOf(pointer.issue, [...keys, ...pointer.path])),
    Match.tag("Composite", (composite) => furthestOf(composite.issues)),
    Match.tag("AnyOf", (anyOf) => {
      const none = { keys, message: "isn't any of the forms this can take", missing: false };

      return Option.some(
        Option.match(furthestOf(anyOf.issues), {
          onNone: () => none,
          onSome: (best) => {
            if (best.missing && best.keys.length <= keys.length + 1) {
              return none;
            }

            return best;
          },
        }),
      );
    }),
    Match.tag("MissingKey", () => Option.some({ keys, message: "is missing", missing: true })),
    Match.orElse((other) =>
      Option.some({ keys, message: new Schema.SchemaError(other).message, missing: false }),
    ),
  );
};

const decodeDocument = Schema.decodeUnknownResult(FlowDocument);

// A document's shape: whatever a parser made of its text, or what is wrong with
// its form and where. What an author most often gets wrong is checked by hand,
// for a plainer account; the schema has the last word, at the place in the
// document it got furthest into.
export const read = (value: Schema.Json): Result.Result<FlowDocument, ReadonlyArray<Problem>> => {
  const problems = documentProblems(value);

  if (problems.length > 0) {
    return Result.fail(problems);
  }

  return Result.mapError(decodeDocument(value), (error) =>
    Option.toArray(mismatchOf(error.issue, [])).map(({ keys, message }) => ({
      path: pathTo(keys),
      message,
    })),
  );
};

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
  "runStage",
  "catalogue",
  "failureContext",
  "item",
  "sources",
  "subjects",
  "lanes",
  "loopStates",
  "round",
  "state",
  "trigger",
]);

// A list as a sentence names it, or "nothing" for an empty one.
const listed = (names: ReadonlyArray<string>, nothing: string) =>
  Option.getOrElse(
    Option.liftPredicate(names.join(", "), () => names.length > 0),
    () => nothing,
  );

export const isEnd = (step: Step): step is EndStep => "end" in step;

export const isUse = (step: Step): step is UseStep => "use" in step;

export const isStage = (step: Step): step is StageStep => "stage" in step;

// A step that runs something and may branch on it: a block's, or a stage's.
type CallStep = UseStep | StageStep;

const isCall = (step: Step): step is CallStep => isUse(step) || isStage(step);

const isNext = (step: Step): step is NextStep => "next" in step;

export const isRepeat = (step: Step): step is RepeatStep => "repeat" in step;

export const isForEach = (step: Step): step is ForEachStep => "forEach" in step;

const isFirst = (step: Step): step is FirstStep => "first" in step;

const rootOf = (reference: string) => reference.split(".")[0];

const branchesOf = (step: CallStep): ReadonlyArray<readonly [string, Branch]> =>
  Object.entries(step.on ?? {});

const inside = (step: Step): ReadonlyArray<Step> => {
  if (isRepeat(step)) {
    return step.repeat.steps;
  }

  if (isForEach(step)) {
    return step.steps;
  }

  if (isCall(step)) {
    return branchesOf(step).flatMap(([, branch]) => branch.steps);
  }

  return [];
};

const boundBy = (step: Step): ReadonlyArray<string> => {
  if (!isCall(step)) {
    return [];
  }

  return branchesOf(step).flatMap(([, branch]) =>
    Option.toArray(Option.fromUndefinedOr(branch.as)),
  );
};

const idOf = (step: Step): ReadonlyArray<string> => {
  if ("id" in step) {
    return [step.id];
  }

  return [];
};

const declaredIn = (steps: ReadonlyArray<Step>): ReadonlyArray<string> =>
  steps.flatMap((step) => [...idOf(step), ...boundBy(step), ...declaredIn(inside(step))]);

const usedIn = (steps: ReadonlyArray<Step>): ReadonlyArray<string> =>
  steps.flatMap((step) => {
    if (isUse(step)) {
      return [step.use, ...usedIn(inside(step))];
    }

    return usedIn(inside(step));
  });

const stagesIn = (steps: ReadonlyArray<Step>): ReadonlyArray<string> =>
  steps.flatMap((step) => {
    if (isStage(step)) {
      return [step.stage, ...stagesIn(inside(step))];
    }

    return stagesIn(inside(step));
  });

const hasEnd = (steps: ReadonlyArray<Step>): boolean =>
  steps.some((step) => {
    if (isForEach(step)) {
      return false;
    }

    return isEnd(step) || hasEnd(inside(step));
  });

// What a check of one document keeps as it walks.
type Checking = {
  readonly problems: Array<Problem>;
  readonly subject: string;
  readonly fields: ReadonlyArray<string>;
  // The files in the repo's .chernabog/stages/.
  readonly stages: ReadonlyArray<string>;
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
    say(
      checking,
      at,
      "must name an earlier step by its id, or a field of its output as step.field",
    );

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

  const fixed: ReadonlyArray<string> = block.fixed;

  for (const [input, reference] of Object.entries(wired)) {
    if (!(input in block.inputs)) {
      say(checking, `${at}.in.${input}`, `${step.use} takes ${takes}`);
    }

    if (fixed.includes(input)) {
      say(checking, `${at}.in.${input}`, `${input} is a fixed value: put it under with, not in`);

      continue;
    }

    if (Predicate.isString(reference)) {
      checkReference(checking, names, reference, `${at}.in.${input}`);
    } else {
      say(
        checking,
        `${at}.in.${input}`,
        "in names an earlier step's output; a fixed value goes under with",
      );
    }
  }

  for (const input of Object.keys(given)) {
    if (!(input in block.inputs)) {
      say(checking, `${at}.with.${input}`, `${step.use} takes ${takes}`);
    } else if (!fixed.includes(input) && !block.either.includes(input)) {
      say(
        checking,
        `${at}.with.${input}`,
        `${input} comes from an earlier step: put it under in, as step or step.field`,
      );
    }
  }
};

// A name the document gives something, which the flow file declares as it is:
// it must be a name, and one the file doesn't already have.
const checkName = (
  checking: Checking,
  name: string,
  names: ReadonlySet<string>,
  at: string,
  what: string,
) => {
  if (!IDENTIFIER.test(name) || RESERVED.has(name)) {
    say(checking, at, `${name} can't name ${what}`);
  } else if (names.has(name)) {
    say(checking, at, `${name} is already a step here`);
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
  checkName(checking, step.id, names, `${at}.id`, "a step");

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
    checkName(checking, name, names, at, "what a branch binds");
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

// Where a walk is: inside a repeat, `next` means something, and its rounds'
// steps run again each round; inside a lane, they run once for each lane.
type Place = { readonly inLoop: boolean; readonly inLane: boolean };

// A run resumes by its step names, and a second use of one replays the first's
// result instead of doing the work. A block that runs steps in every round, or
// in every lane, must carry the round or the lane in their names.
const checkStepKey = (
  checking: Checking,
  step: UseStep,
  block: Block,
  place: Place,
  at: string,
) => {
  if (block.stepNames.length === 0) {
    return;
  }

  const wired = step.in ?? {};

  if (place.inLane) {
    if (!("lane" in block.inputs)) {
      say(
        checking,
        `${at}.use`,
        `${step.use} names its steps the same in every lane, so it can't run beside others`,
      );
    } else if (!("lane" in wired)) {
      say(checking, `${at}.in`, `${step.use} runs beside others here, and must name its lane`);
    }

    return;
  }

  if (place.inLoop) {
    if (!("round" in block.inputs)) {
      say(
        checking,
        `${at}.use`,
        `${step.use} names its steps the same in every round, so it can't run in a repeat`,
      );
    } else if (wired.round !== "round") {
      say(checking, `${at}.in.round`, `${step.use} runs in every round here, and must take round`);
    }
  }
};

// Whether every way past a block's step has waited or changed something.
// How the steps of a branch are walked for a spin: whether a way reaches
// their end having neither waited nor changed anything.
type Spin = (steps: ReadonlyArray<Step>, settled: boolean, path: string) => boolean;

const settledPast = (step: UseStep, settled: boolean, at: string, spin: Spin) => {
  const found = Record.get(blocksByName, step.use);

  if (Option.isNone(found)) {
    return settled;
  }

  const block = found.value;
  const routed = step.on ?? {};

  // Taking a branch, the block ran, whether or not it had to.
  const changedOn = (outcome: string) =>
    block.waits ||
    block.progressOn.some((each) => each === outcome) ||
    Option.exists(block.progressUnless, (unless) => unless !== outcome);

  const unsettled = branchesOf(step).map(([outcome, branch]) =>
    spin(branch.steps, settled || changedOn(outcome), `${at}.on.${outcome}.steps`),
  );

  // Past it without a branch, a conditional step may not have run at all.
  const runs = Option.isNone(Option.fromUndefinedOr(step.if));

  const past =
    settled ||
    (runs && (block.waits || Option.exists(block.progressUnless, (unless) => unless in routed)));

  return past && !unsettled.some((each) => each);
};

// A way round a loop that neither waits nor changes anything would spin. Says
// so of each `next` a way reaches so, and returns whether a way reaches the
// end of the steps so. Lanes are no way round: there may be none.
const checkSpin = (
  checking: Checking,
  steps: ReadonlyArray<Step>,
  settled: boolean,
  path: string,
): boolean => {
  let still = settled;

  for (const [index, step] of steps.entries()) {
    const at = `${path}[${index}]`;

    if (isNext(step)) {
      if (!still) {
        say(checking, at, "this round neither waits nor changes anything, so the loop would spin");
      }

      return false;
    }

    if (isEnd(step) || isRepeat(step)) {
      return false;
    }

    if (isUse(step)) {
      still = settledPast(step, still, at, (inner, from, where) =>
        checkSpin(checking, inner, from, where),
      );
    }
  }

  return !still;
};

const checkLoop = (checking: Checking, step: RepeatStep, at: string) => {
  if (!hasEnd(step.repeat.steps)) {
    say(checking, `${at}.repeat`, "no round ends this loop");
  }

  checkSpin(checking, step.repeat.steps, false, `${at}.repeat.steps`);

  for (const [name, init] of Object.entries(step.repeat.state)) {
    if (!Object.keys(loopStates).includes(init)) {
      say(
        checking,
        `${at}.repeat.state.${name}`,
        `must start from one of ${Object.keys(loopStates).join(", ")}`,
      );
    }
  }
};

type Walk = (
  steps: ReadonlyArray<Step>,
  path: string,
  scope: ReadonlySet<string>,
  seen: Used,
  place: Place,
) => Walked;

const checkEnd = (checking: Checking, step: EndStep, names: ReadonlySet<string>, at: string) => {
  if (step.end === "needs-human") {
    checkReference(checking, names, step.reason, `${at}.reason`);

    return;
  }

  for (const summary of Option.toArray(Option.fromUndefinedOr(step.summary))) {
    checkReference(checking, names, summary, `${at}.summary`);
  }
};

const checkNext = (
  checking: Checking,
  step: NextStep,
  names: ReadonlySet<string>,
  place: Place,
  at: string,
) => {
  if (!place.inLoop) {
    say(checking, at, "next means something only inside a repeat");
  }

  for (const [name, reference] of Object.entries(step.next)) {
    checkReference(checking, names, reference, `${at}.next.${name}`);
  }
};

const checkForEach = (
  checking: Checking,
  step: ForEachStep,
  names: ReadonlySet<string>,
  walk: Walk,
  at: string,
) => {
  checkReference(checking, names, step.forEach, `${at}.forEach`);
  checkReference(checking, names, step.atOnce, `${at}.atOnce`);

  if (!Object.keys(laneScopes).includes(step.scope)) {
    say(checking, `${at}.scope`, `must be one of ${Object.keys(laneScopes).join(", ")}`);
  }

  checkName(checking, step.id, names, `${at}.id`, "a step");
  checkName(checking, step.as, names, `${at}.as`, "each item");

  for (const [field, references] of Object.entries(step.failureContext ?? {})) {
    if (!IDENTIFIER.test(field)) {
      say(checking, `${at}.failureContext.${field}`, `${field} can't name what a lane keeps`);
    }

    for (const reference of references) {
      if (!REFERENCE.test(reference)) {
        say(checking, `${at}.failureContext.${field}`, "must name a step's output, as step.field");
      }
    }
  }

  // A lane's steps carry its id, as checkStepKey sees to, so each lane's names
  // are its own.
  walk(step.steps, `${at}.steps`, new Set([...names, step.as]), new Map(), {
    inLoop: false,
    inLane: true,
  });
};

const checkRepeat = (
  checking: Checking,
  step: RepeatStep,
  names: ReadonlySet<string>,
  place: Place,
  walk: Walk,
  at: string,
) => {
  checkName(checking, step.id, names, `${at}.id`, "a step");
  checkLoop(checking, step, at);

  // A round's steps carry its number, as checkStepKey sees to, so each round's
  // names are its own.
  const round = walk(
    step.repeat.steps,
    `${at}.repeat.steps`,
    new Set([...names, "round", "state"]),
    new Map(),
    { ...place, inLoop: true },
  );

  // Running off its steps would go round again, and lose what the round changed.
  if (!round.ends) {
    say(
      checking,
      `${at}.repeat.steps`,
      "a round can run off its steps: end it, or go on with next",
    );
  }
};

const checkFirst = (
  checking: Checking,
  step: FirstStep,
  names: ReadonlySet<string>,
  at: string,
) => {
  checkName(checking, step.id, names, `${at}.id`, "a step");

  if (step.first.length === 0) {
    say(checking, `${at}.first`, "must name at least one output");
  }

  for (const reference of step.first) {
    checkReference(checking, names, reference, `${at}.first`);
  }
};

// A stage is .chernabog/stages/<name>.ts (or .js, .mts, .mjs), an Effect stage,
// or an executable <name>, a shell stage, as a run finds it.
const STAGE_EXTENSIONS = [".ts", ".js", ".mts", ".mjs"];

// The file of the Effect stage a name finds among the stages' files.
const stageFileOf = (stages: ReadonlyArray<string>, name: string) =>
  Arr.findFirst(
    STAGE_EXTENSIONS.map((extension) => `${name}${extension}`),
    (file) => stages.includes(file),
  );

// The Effect stages there are, by name.
const effectStages = (stages: ReadonlyArray<string>) =>
  [
    ...new Set(
      stages.flatMap((file) =>
        Option.toArray(
          Option.map(
            Arr.findFirst(STAGE_EXTENSIONS, (extension) => file.endsWith(extension)),
            (extension) => file.slice(0, -extension.length),
          ),
        ),
      ),
    ),
  ].toSorted();

// What a stage can fail with: exit 78 skips, any other failure fails. A stage
// has no table of its own, so a document must say what each means.
const STAGE_FAILURES = ["Skip", "StepFailed"];

const DISPOSITIONS = ["person", "told", "skip", "fail"];

const DISPOSITIONS_SAID = "person, told, skip or fail";

// Whether the stage is there, and one a document can type: an executable's
// output has no types to check its wires by.
const checkStageFile = (checking: Checking, step: StageStep, at: string) => {
  if (Option.isSome(stageFileOf(checking.stages, step.stage))) {
    return true;
  }

  const extension = Arr.findFirst(STAGE_EXTENSIONS, (each) => step.stage.endsWith(each));

  if (Option.isSome(extension)) {
    say(
      checking,
      `${at}.stage`,
      `names a stage by its file without the extension: ${step.stage.slice(0, -extension.value.length)}`,
    );
  } else if (checking.stages.includes(step.stage)) {
    say(
      checking,
      `${at}.stage`,
      `${step.stage} is a shell stage, whose output has no types: wrap it in an Effect stage, .chernabog/stages/${step.stage}.ts, that default-exports defineStage({ name, input, output, run })`,
    );
  } else {
    say(
      checking,
      `${at}.stage`,
      `no stage named ${step.stage} in .chernabog/stages/; there are ${listed(effectStages(checking.stages), "none")}`,
    );
  }

  return false;
};

const checkStageFailures = (checking: Checking, step: StageStep, at: string) => {
  const failure = step.failure ?? {};

  for (const tag of STAGE_FAILURES.filter((each) => !(each in failure))) {
    say(
      checking,
      `${at}.failure`,
      `${step.stage} can fail with ${tag}, and this doesn't say what that means: give failure.${tag} as ${DISPOSITIONS_SAID}`,
    );
  }

  for (const [tag, disposition] of Object.entries(failure)) {
    if (!STAGE_FAILURES.includes(tag)) {
      say(checking, `${at}.failure.${tag}`, "a stage fails only with Skip or StepFailed");
    } else if (!(Predicate.isString(disposition) && DISPOSITIONS.includes(disposition))) {
      say(checking, `${at}.failure.${tag}`, `must be ${DISPOSITIONS_SAID}`);
    }
  }
};

// As checkStepKey has a block's: a stage's step is named by its round or lane,
// which it takes under `in`.
const checkStageKey = (checking: Checking, step: StageStep, place: Place, at: string) => {
  const wired = step.in ?? {};

  if (place.inLane) {
    if (!("lane" in wired)) {
      say(checking, `${at}.in`, `${step.stage} runs beside others here, and must name its lane`);
    }

    return;
  }

  if (place.inLoop && wired.round !== "round") {
    say(checking, `${at}.in.round`, `${step.stage} runs in every round here, and must take round`);
  }
};

// The group of step names a stage's run uses: its own name.
const stageSteps = (step: StageStep) => `stage ${step.stage}`;

const checkStage = (
  checking: Checking,
  step: StageStep,
  names: Set<string>,
  used: Map<string, string>,
  place: Place,
  at: string,
) => {
  if (!checkStageFile(checking, step, at)) {
    return;
  }

  checkName(checking, step.id, names, `${at}.id`, "a step");

  if (used.has(stageSteps(step))) {
    say(
      checking,
      `${at}.stage`,
      `${step.stage} runs twice on one path, and its step names would collide`,
    );
  }

  used.set(stageSteps(step), step.stage);

  for (const [input, reference] of Object.entries(step.in ?? {})) {
    if (Predicate.isString(reference)) {
      checkReference(checking, names, reference, `${at}.in.${input}`);
    } else {
      say(
        checking,
        `${at}.in.${input}`,
        "in names an earlier step's output; a fixed value goes under with",
      );
    }
  }

  checkStageFailures(checking, step, at);

  // Its output is whatever its schema says, with no outcomes declared.
  for (const outcome of Object.keys(step.on ?? {})) {
    say(checking, `${at}.on.${outcome}`, `${step.stage} comes to nothing to route`);
  }

  checkStageKey(checking, step, place, at);

  for (const flag of Option.toArray(Option.fromUndefinedOr(step.if))) {
    checkReference(checking, names, flag, `${at}.if`);
  }
};

// What a block's step left: whether every run ends in it.
const checkUse = (
  checking: Checking,
  step: UseStep,
  names: Set<string>,
  used: Map<string, string>,
  place: Place,
  walk: Walk,
  at: string,
) => {
  const found = Record.get(blocksByName, step.use);

  if (Option.isNone(found)) {
    say(
      checking,
      `${at}.use`,
      `no block named ${step.use}; there are ${Object.keys(catalogue).join(", ")}`,
    );

    return false;
  }

  const block = found.value;

  checkIdentity(checking, step, block, names, used, at);

  for (const name of block.stepNames) {
    used.set(name, step.use);
  }

  checkInputs(checking, step, block, names, at);
  checkRouting(checking, step, block, at);
  checkStepKey(checking, step, block, place, at);

  for (const flag of Option.toArray(Option.fromUndefinedOr(step.if))) {
    checkReference(checking, names, flag, `${at}.if`);
  }

  names.add(step.id);

  const walked = branchesOf(step).map(([outcome, branch]) => {
    checkBinding(checking, branch, names, `${at}.on.${outcome}.as`);

    return walk(
      branch.steps,
      `${at}.on.${outcome}.steps`,
      new Set([...names, ...Option.toArray(Option.fromUndefinedOr(branch.as))]),
      used,
      place,
    );
  });

  // A branch that doesn't end carries on into what follows, with what it used.
  for (const [name, use] of walked.filter((branch) => !branch.ends).flatMap((b) => [...b.seen])) {
    used.set(name, use);
  }

  return (
    block.exhaustive &&
    Object.keys(block.outcomes).every((key) => key in (step.on ?? {})) &&
    walked.every((branch) => branch.ends)
  );
};

// Walks the steps as a run goes through them, with the names it has at each
// and the blocks it has used.
const checkSteps =
  (checking: Checking): Walk =>
  (steps, path, scope, seen, place) => {
    const walk = checkSteps(checking);
    const names = new Set(scope);
    const used = new Map(seen);

    const stopsAt = (index: number) => {
      if (index < steps.length - 1) {
        say(checking, `${path}[${index + 1}]`, "no run can reach this step");
      }

      return { ends: true, seen: used };
    };

    for (const [index, step] of steps.entries()) {
      const at = `${path}[${index}]`;

      if (isEnd(step)) {
        checkEnd(checking, step, names, at);

        return stopsAt(index);
      }

      if (isNext(step)) {
        checkNext(checking, step, names, place, at);

        return stopsAt(index);
      }

      if (isRepeat(step)) {
        checkRepeat(checking, step, names, place, walk, at);

        return stopsAt(index);
      }

      if (isFirst(step)) {
        checkFirst(checking, step, names, at);
      }

      if (isForEach(step)) {
        checkForEach(checking, step, names, walk, at);
      }

      if (isStage(step)) {
        checkStage(checking, step, names, used, place, at);
      }

      if (isUse(step) && checkUse(checking, step, names, used, place, walk, at)) {
        return stopsAt(index);
      }

      for (const id of idOf(step)) {
        names.add(id);
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

// Goes down every way through the steps, and says where a block's order is
// broken, or a way that finishes well leaves something it should have done.
// Ways that meet at a step with the same state go on alike, so each state is
// walked once: a chain of steps that may not run is as many ways as it has
// steps, not two to its length, and a round that goes on with nothing new
// stops.
type Ordering = {
  readonly say: (path: string, message: string) => void;
  readonly walked: Set<string>;
};

type Placed = { readonly step: Step; readonly at: string };

type Way = {
  // What ran in this round, or since the start for a way in no loop: a block
  // that runs before another does so within a round.
  readonly seen: ReadonlyArray<string>;
  // What ran since the start, in any round: a block that needs another needs
  // it to have run at all.
  readonly ran: ReadonlyArray<string>;
  // What is left to do, and the block that left it.
  readonly open: ReadonlyMap<string, string>;
  // Where the steps walked end, for a way that runs off them; none in a round,
  // which runs on into the next.
  readonly endsAt: Option.Option<string>;
  // The loop a next goes round, and what had run when it started.
  readonly round: Option.Option<Round>;
};

type Round = { readonly steps: ReadonlyArray<Placed>; readonly seen: ReadonlyArray<string> };

const namesOf = (names: ReadonlyArray<string>) => [...new Set(names)].toSorted().join(",");

// Where a way is and what it carries: all that what's said further on depends on.
const stateOf = (items: ReadonlyArray<Placed>, way: Way) =>
  [
    items.map((item) => item.at).join(","),
    Option.getOrElse(way.endsAt, () => ""),
    Option.match(way.round, { onNone: () => "", onSome: (round) => namesOf(round.seen) }),
    namesOf(way.seen),
    namesOf(way.ran),
    [...way.open]
      .map(([what, by]) => `${what}=${by}`)
      .toSorted()
      .join(","),
  ].join(";");

const placed = (steps: ReadonlyArray<Step>, path: string): ReadonlyArray<Placed> =>
  steps.map((step, index) => ({ step, at: `${path}[${index}]` }));

const sayUndone = (ordering: Ordering, way: Way, at: string) => {
  for (const [what, by] of way.open) {
    ordering.say(at, `a way through ${by} finishes here with ${what} not done`);
  }
};

const entering = (ordering: Ordering, step: UseStep, block: Block, at: string, way: Way): Way => {
  const before: ReadonlyArray<string> = block.before;
  const needs: ReadonlyArray<string> = block.needs;

  for (const later of before.filter((each) => way.seen.includes(each))) {
    ordering.say(at, `${step.use} must run before ${later}, and this runs after it`);
  }

  for (const earlier of needs.filter((each) => !way.ran.includes(each))) {
    ordering.say(at, `${step.use} needs ${earlier} to have run first`);
  }

  const closes: ReadonlyArray<string> = block.closes;
  const opens: ReadonlyArray<string> = block.opens;

  return {
    ...way,
    seen: [...way.seen, step.use],
    ran: [...way.ran, step.use],
    open: new Map([
      ...[...way.open].filter(([what]) => !closes.includes(what)),
      ...opens.map((what) => [what, step.use] as const),
    ]),
  };
};

const walkOrder = (ordering: Ordering, items: ReadonlyArray<Placed>, way: Way): void => {
  const state = stateOf(items, way);

  if (ordering.walked.has(state)) {
    return;
  }

  ordering.walked.add(state);

  if (items.length === 0) {
    for (const at of Option.toArray(way.endsAt)) {
      sayUndone(ordering, way, at);
    }

    return;
  }

  const [{ at, step }, ...rest] = items;

  if (isEnd(step)) {
    if (step.end === "done") {
      sayUndone(ordering, way, at);
    }

    return;
  }

  // The next round starts with what this one left to do, and what has run.
  if (isNext(step)) {
    for (const round of Option.toArray(way.round)) {
      walkOrder(ordering, round.steps, { ...way, seen: round.seen });
    }

    return;
  }

  if (isRepeat(step)) {
    const steps = placed(step.repeat.steps, `${at}.repeat.steps`);

    walkOrder(ordering, steps, {
      ...way,
      endsAt: Option.none(),
      round: Option.some({ steps, seen: way.seen }),
    });

    return;
  }

  if (isForEach(step)) {
    // A lane ends for itself, with what it left to do its own.
    walkOrder(ordering, placed(step.steps, `${at}.steps`), {
      seen: way.seen,
      ran: way.ran,
      open: new Map(),
      endsAt: Option.some(`${at}.steps`),
      round: Option.none(),
    });
  }

  if (!isUse(step)) {
    walkOrder(ordering, rest, way);

    return;
  }

  const found = Record.get(blocksByName, step.use);

  if (Option.isNone(found)) {
    walkOrder(ordering, rest, way);

    return;
  }

  const block = found.value;
  const entered = entering(ordering, step, block, at, way);

  for (const [outcome, branch] of branchesOf(step)) {
    const opened: ReadonlyArray<string> = Record.get(block.opensOn, outcome).pipe(
      Option.getOrElse((): ReadonlyArray<string> => []),
    );

    walkOrder(ordering, [...placed(branch.steps, `${at}.on.${outcome}.steps`), ...rest], {
      ...entered,
      open: new Map([...entered.open, ...opened.map((what) => [what, step.use] as const)]),
    });
  }

  const everyOutcome = Object.keys(block.outcomes).every((key) => key in (step.on ?? {}));

  if (!(block.exhaustive && everyOutcome)) {
    walkOrder(ordering, rest, entered);
  }

  // A step that may not run leaves the way as it was.
  if (Option.isSome(Option.fromUndefinedOr(step.if))) {
    walkOrder(ordering, rest, way);
  }
};

const checkOrder = (checking: Checking, document: FlowDocument) => {
  const said = new Set<string>();

  walkOrder(
    {
      say: (path, message) => {
        if (!said.has(`${path}:${message}`)) {
          said.add(`${path}:${message}`);
          say(checking, path, message);
        }
      },
      walked: new Set(),
    },
    placed(document.steps, "steps"),
    {
      seen: [],
      ran: [],
      open: new Map(),
      endsAt: Option.some("steps"),
      round: Option.none(),
    },
  );
};

// Each step that uses a block, with where in the document it is, down every
// branch, round and lane.
const usesIn = (
  steps: ReadonlyArray<Step>,
  path: string,
): ReadonlyArray<readonly [UseStep, string]> =>
  steps.flatMap((step, index): ReadonlyArray<readonly [UseStep, string]> => {
    const at = `${path}[${index}]`;

    if (isRepeat(step)) {
      return usesIn(step.repeat.steps, `${at}.repeat.steps`);
    }

    if (isForEach(step)) {
      return usesIn(step.steps, `${at}.steps`);
    }

    if (!isCall(step)) {
      return [];
    }

    const branches = branchesOf(step).flatMap(([outcome, branch]) =>
      usesIn(branch.steps, `${at}.on.${outcome}.steps`),
    );

    if (isUse(step)) {
      return [[step, at], ...branches];
    }

    return branches;
  });

// The subjects a person can start a flow on.
const startable = Object.keys(subjects).filter((subject) => Option.isSome(startOf(subject)));

// A flow a person starts: on a subject they can name, with no trigger, and so
// with no block that parks until a trigger wakes it, since none would.
const checkStart = (checking: Checking, document: FlowDocument) => {
  if (Option.isNone(startOf(document.subject))) {
    say(
      checking,
      "start",
      `a person starts only a flow on ${listed(startable, "nothing")}, with chernabog start <issue>, and this is a flow on ${document.subject}`,
    );
  }

  if (document.trigger.length > 0) {
    say(
      checking,
      "start",
      "a flow a person starts has no trigger: say start: true or name a trigger, not both",
    );
  }

  for (const [step, at] of usesIn(document.steps, "steps")) {
    const woken = Option.flatMap(Record.get(blocksByName, step.use), (block) =>
      Option.fromUndefinedOr(block.contributes.wakes),
    );

    if (Option.isSome(woken)) {
      say(
        checking,
        `${at}.use`,
        `${step.use} waits for the flow's trigger to wake it, and a flow a person starts has no trigger`,
      );
    }
  }
};

const checkTrigger = (checking: Checking, document: FlowDocument) => {
  if (document.start === true) {
    checkStart(checking, document);

    return;
  }

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
// `stages` are the files in the repo's .chernabog/stages/, which a stage step
// names.
export const check = (
  document: FlowDocument,
  stages: ReadonlyArray<string> = [],
): ReadonlyArray<Problem> => {
  const subject = Record.get(subjectsByName, document.subject);

  if (Option.isNone(subject)) {
    return [{ path: "subject", message: `must be one of ${Object.keys(subjects).join(", ")}` }];
  }

  const checking: Checking = {
    problems: [],
    subject: document.subject,
    fields: subject.value.fields,
    stages,
  };

  if (!FLOW_NAME.test(document.flow)) {
    say(checking, "flow", "must be a flow name");
  }

  checkTrigger(checking, document);
  checkSteps(checking)(document.steps, "steps", new Set(["trigger"]), new Map(), {
    inLoop: false,
    inLane: false,
  });
  checkFailureContext(checking, document, subject.value.failureContext);
  checkOrder(checking, document);

  return checking.problems;
};

// How a document is written, for someone with nothing else to go on.
const FORMAT = `A flow document is YAML at .chernabog/documents/<flow>.yaml. chernabog recipes compile <flow> checks it and writes its flow file.

flow: quick-fix                  # the file's name
subject: issue                   # one of the subjects below: what a run works on
gate: usage                      # optional: hold runs while the agent's usage is low
concurrency: 1                   # optional
trigger:                         # the sources below: where its work comes from
  - use: issues.queued
    with: { labels: [eligible] }
# start: true                    # in place of trigger: a person starts each run, with chernabog start <issue>
failureContext:                  # optional, when the subject keeps one: what a failure can tell a person
  pr: [opened.number]            # the outputs that set it
steps:
  - id: claim                    # your name for the step; later steps name it
    use: issue.claim             # a block below
    in: { issue: trigger.issue, queued: trigger.queued }   # inputs wired to earlier outputs
    with: { adopt: false }       # inputs that are fixed values; the listing says which
  - id: worktree
    use: worktree.prepare
    in: { branch: claim.branch, base: claim.base }
  - id: agent
    use: agent.implement
    in: { issue: trigger.issue, worktree: worktree, base: claim.base }
    on:                          # outcomes the block lists; "must route" ones are required
      needs-clarification:
        as: questions            # optional: names what the outcome binds
        steps:
          - id: asked
            use: issue.askClarification
            in: { issue: trigger.issue, outcome: questions, queued: trigger.queued }
          - end: needs-human     # stops, waiting on a person
            reason: asked
  - end: done                    # optional at the very end
    summary: agent.outcome.summary

A reference under in, summary or reason is a step's id, for its whole output, or step.field for one field of it, or trigger.<field>. A step's output is available to the steps after it, and an outcome's steps can use what the steps before them gave. After a branch's steps, a run goes on to the next step unless they end.

A block's failures are handled as it lists them: person tells a person and stops, told stops because a person already knows, skip ends with nothing to do, fail ends failed. Add failure: { <error>: <one of those> } to a step only to change one.

A compiled flow runs once the flow file is on the default branch and a persona's flows in machine config list it.

A flow a person starts says start: true and has no trigger: nothing finds its work on a schedule, and it runs only when a person names an issue, with chernabog start <issue>, whatever its labels. Only a subject whose listing says start can be started. Each run is the person's, and a block that waits for a trigger to wake it can't be used.

Add if: <step.field>, a boolean output, to run a step only sometimes. Its output is then optional, and { id: x, first: [maybeRan, standIn] } gives the first that ran.

{ id: rounds, repeat: { state: { <name>: <a loop state> }, steps: [...] } } loops: its steps have round and state.<name>, and { next: { <name>: <reference> } } starts the next round with that state changed. Some way must end the loop, and every way round must wait or change something.

{ id: x, forEach: <list>, as: item, scope: <a lane scope>, atOnce: <number output>, steps: [...] } runs its steps once per item, beside each other; blocks there wire lane.

A step of the repo's own, for work no block covers, runs from .chernabog/stages/ with stage: in place of use:
  - id: found
    stage: find-work             # .chernabog/stages/find-work.ts, which default-exports defineStage
    in: { issue: trigger.issue } # wired, as a block's inputs are; fixed values go under with
    failure: { Skip: skip, StepFailed: person }
Only an Effect stage can run here: its input and output schemas type its wires both ways, as a block's types do. A shell stage has no types; wrap it in an Effect stage. A stage has no failure table of its own, so failure must say what each of its failures means: Skip (it exited 78) and StepFailed (any other failure), each person, told, skip or fail. A stage comes to no outcomes; branch on a boolean output of it with if on a later step. In a repeat, in: { round: round } names its step each round; beside others, in: { lane: <item>.lane } names it each lane; neither goes into its input.`;

// A stage as `describe` lists it: its name, and the schemas of its input and
// output, as its module's defineStage gives them.
export type StageDefinition = {
  readonly name: string;
  readonly input: Schema.Top;
  readonly output: Schema.Top;
};

const optionalMark = (ast: SchemaAST.AST) =>
  Option.getOrElse(
    Option.liftPredicate("?", () => SchemaAST.isOptional(ast)),
    () => "",
  );

// A word for what a value is, from its schema: what a document wires to it.
const kindOf = (ast: SchemaAST.AST): string =>
  Match.value(ast).pipe(
    Match.tag("Objects", (objects) => {
      const fields = objects.propertySignatures.map(
        (property) =>
          `${String(property.name)}${optionalMark(property.type)}: ${kindOf(property.type)}`,
      );

      return `{ ${fields.join(", ")} }`;
    }),
    Match.tag("Arrays", (arrays) => {
      const rest = arrays.rest.map(kindOf);

      if (arrays.elements.length === 0 && rest.length === 1) {
        return `Array<${rest.join("")}>`;
      }

      return `[${[...arrays.elements.map(kindOf), ...rest.map((each) => `...${each}[]`)].join(", ")}]`;
    }),
    Match.tag("Union", (union) => union.types.map(kindOf).join(" | ")),
    Match.tag("Literal", (literal) => printJson(String(literal.literal))),
    Match.tag("Suspend", (suspended) => kindOf(suspended.thunk())),
    Match.tag("Declaration", (declaration) => {
      const name = Option.getOrElse(
        Option.filter(Option.fromNullishOr(declaration.annotations?.expected), Predicate.isString),
        () => "a value",
      );

      if (declaration.typeParameters.length === 0) {
        return name;
      }

      return `${name}<${declaration.typeParameters.map(kindOf).join(", ")}>`;
    }),
    Match.orElse((other) => other._tag.toLowerCase()),
  );

const fieldsOf = (ast: SchemaAST.AST) =>
  Option.map(Option.liftPredicate(ast, SchemaAST.isObjects), (objects) =>
    objects.propertySignatures.map((property) => ({
      name: String(property.name),
      optional: SchemaAST.isOptional(property.type),
      kind: kindOf(property.type),
    })),
  );

const describeStage = (stage: StageDefinition) => {
  const output = SchemaAST.toType(stage.output.ast);

  const inputs = Option.getOrElse(fieldsOf(SchemaAST.toType(stage.input.ast)), () => []).map(
    (field) => ({
      name: field.name,
      required: !field.optional,
      under: "in or with",
      kind: field.kind,
    }),
  );

  const gives: Schema.Json = Option.match(fieldsOf(output), {
    onNone: () => kindOf(output),
    onSome: (fields) => Object.fromEntries(fields.map((field) => [field.name, field.kind])),
  });

  return { name: stage.name, inputs, gives, failures: STAGE_FAILURES };
};

// Everything a document can use, for an agent or a person composing one, with
// the repo's Effect stages when given them.
export const describe = (stages: ReadonlyArray<StageDefinition> = []): Schema.Json => ({
  format: FORMAT,
  subjects: Object.entries(subjects).map(([name, subject]) => ({
    name,
    // Whether a person can start a flow on it, with start: true.
    start: Option.isSome(startOf(name)),
    trigger: [...subject.fields],
    failureContext: [...subject.failureContext],
  })),
  sources: Object.entries(sourceDescriptions).map(([name, source]) => ({
    name,
    about: source.about,
    with: source.with,
  })),
  loopStates: Object.keys(loopStates),
  laneScopes: Object.keys(laneScopes),
  blocks: Object.values(blocksByName).map((block) => ({
    name: block.name,
    about: block.about,
    inputs: Object.entries(block.inputs).map(([name, need]) => ({
      name,
      required: need === "required",
      under: Option.getOrElse(
        Option.orElse(
          Option.liftPredicate("with" as const, () => block.fixed.includes(name)),
          () => Option.liftPredicate("in or with" as const, () => block.either.includes(name)),
        ),
        () => "in" as const,
      ),
      kind: block.inputKinds[name] ?? "",
    })),
    gives: block.outputKinds,
    outcomes: Object.keys(block.outcomes).map((name) => ({
      name,
      mustRoute: block.mustRoute.some((routed) => routed === name),
      binds: block.outcomeKinds[name] ?? "",
    })),
    failures: block.failures,
    before: [...block.before],
    needs: [...block.needs],
    opens: [...block.opens, ...Object.values(block.opensOn).flat()],
    closes: [...block.closes],
    waits: block.waits,
  })),
  stages: stages.map(describeStage),
});

const emitObject = (entries: ReadonlyArray<readonly [string, string]>) =>
  `{ ${entries.map(([key, code]) => `${printJson(key)}: ${code}`).join(", ")} }`;

type Remembered = { readonly [field: string]: ReadonlyArray<string> };

const emitRemembered = (remembered: Remembered, name: string, indent: string) =>
  Object.entries(remembered).flatMap(([field, references]) =>
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
  remembered: Remembered,
  step: UseStep,
  outcome: string,
  branch: Branch,
  indent: string,
  body: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const taken = `${step.id}_${outcome.replaceAll(/\W/g, "_")}`;
  const outcomes = `catalogue[${printJson(step.use)}].outcomes[${printJson(outcome)}]`;

  const reading = Option.match(Option.fromUndefinedOr(step.if), {
    onNone: () => `${outcomes}(${step.id})`,
    onSome: () => `Option.flatMap(${step.id}, ${outcomes})`,
  });

  const bound = Option.toArray(Option.fromUndefinedOr(branch.as)).flatMap((name) => [
    `${indent}  const ${name} = ${taken}.value;`,
    ...emitRemembered(remembered, name, `${indent}  `),
  ]);

  return [
    `${indent}const ${taken} = ${reading};`,
    `${indent}if (Option.isSome(${taken})) {`,
    ...bound,
    ...body,
    `${indent}}`,
  ];
};

const emitCall = (step: UseStep, input: string, overrides: string, indent: string) => {
  const call = `yield* catalogue[${printJson(step.use)}].run(${input}${overrides})`;

  return Option.match(Option.fromUndefinedOr(step.if), {
    onNone: () => [`${indent}const ${step.id} = ${call};`],
    onSome: (flag) => [
      `${indent}const ${step.id} = ${flag} === true ? Option.some(${call}) : Option.none();`,
    ],
  });
};

const emitUse = (
  remembered: Remembered,
  step: UseStep,
  indent: string,
  bodyOf: (outcome: string, branch: Branch) => ReadonlyArray<string>,
) => {
  const input = emitObject([
    ...Object.entries(step.in ?? {}).flatMap(([key, reference]) =>
      Option.toArray(
        Option.map(
          Option.liftPredicate(reference, Predicate.isString),
          (code) => [key, code] as const,
        ),
      ),
    ),
    ...Object.entries(step.with ?? {}).map(([key, value]) => [key, printJson(value)] as const),
  ]);

  const overrides = Option.match(Option.fromUndefinedOr(step.failure), {
    onNone: () => "",
    onSome: (failure) => `, ${printJson(failure)}`,
  });

  return [
    ...emitCall(step, input, overrides, indent),
    ...emitRemembered(remembered, step.id, indent),
    ...branchesOf(step).flatMap(([outcome, branch]) =>
      emitBranch(remembered, step, outcome, branch, indent, bodyOf(outcome, branch)),
    ),
  ];
};

// The name a generated flow imports a stage by: its own, with what can't be
// in a name spelled out, so no two stages share one.
const stageImport = (name: string) =>
  `stage_${name.replaceAll(/\W/g, (character) => `$${character.charCodeAt(0)}$`)}`;

// Under `in`, what names a stage's step rather than going into its input.
const STAGE_KEYS = ["round", "lane"];

const wiresOf = (step: StageStep) =>
  Object.entries(step.in ?? {}).flatMap(([key, reference]) =>
    Option.toArray(
      Option.map(
        Option.liftPredicate(reference, Predicate.isString),
        (code) => [key, code] as const,
      ),
    ),
  );

const emitStage = (remembered: Remembered, step: StageStep, indent: string) => {
  const wires = wiresOf(step);

  const input = emitObject([
    ...wires.filter(([key]) => !STAGE_KEYS.includes(key)),
    ...Object.entries(step.with ?? {}).map(([key, value]) => [key, printJson(value)] as const),
  ]);

  const keyed = wires.filter(([key]) => STAGE_KEYS.includes(key));

  const key = Option.getOrElse(
    Option.liftPredicate(emitObject(keyed), () => keyed.length > 0),
    () => "{}",
  );

  const call = `yield* runStage(${printJson(step.stage)}, ${stageImport(step.stage)}, ${input}, ${printJson(step.failure ?? {})}, ${key})`;

  const ran = Option.match(Option.fromUndefinedOr(step.if), {
    onNone: () => `${indent}const ${step.id} = ${call};`,
    onSome: (flag) =>
      `${indent}const ${step.id} = ${flag} === true ? Option.some(${call}) : Option.none();`,
  });

  return [ran, ...emitRemembered(remembered, step.id, indent)];
};

const emitFirst = (step: FirstStep, indent: string) => {
  const last = step.first.at(-1) ?? "";

  const joined = step.first
    .slice(0, -1)
    .toReversed()
    .reduce((rest, each) => `Option.getOrElse(${each}, () => ${rest})`, last);

  return [`${indent}const ${step.id} = ${joined};`];
};

const emitRepeat = (step: RepeatStep, indent: string, body: ReadonlyArray<string>) => {
  const state = emitObject(
    Object.entries(step.repeat.state).map(
      ([name, init]) => [name, `loopStates[${printJson(init)}]()`] as const,
    ),
  );

  return [
    `${indent}let state = ${state};`,
    `${indent}for (let round = 1; ; round++) {`,
    ...body,
    `${indent}}`,
  ];
};

const emitNext = (step: NextStep, indent: string) => [
  `${indent}state = { ...state, ${Object.entries(step.next)
    .map(([name, reference]) => `${printJson(name)}: ${reference}`)
    .join(", ")} };`,
  `${indent}continue;`,
];

const emitForEach = (step: ForEachStep, indent: string, body: ReadonlyArray<string>) => [
  `${indent}const ${step.id} = yield* Effect.forEach(${step.forEach}, (${step.as}) =>`,
  `${indent}  lanes[${printJson(step.scope)}](${step.as}, (failureContext) =>`,
  `${indent}    Effect.gen(function* () {`,
  ...body,
  `${indent}    }),`,
  `${indent}  ),`,
  `${indent}{ concurrency: ${step.atOnce} });`,
];

type EmitSteps = (
  remembered: Remembered,
  steps: ReadonlyArray<Step>,
  path: string,
  indent: string,
) => ReadonlyArray<string>;

const emitStep = (
  emitSteps: EmitSteps,
  remembered: Remembered,
  step: Step,
  path: string,
  indent: string,
): ReadonlyArray<string> => {
  if (isEnd(step)) {
    return [emitEnd(step, indent)];
  }

  if (isNext(step)) {
    return emitNext(step, indent);
  }

  if (isFirst(step)) {
    return emitFirst(step, indent);
  }

  if (isRepeat(step)) {
    return emitRepeat(
      step,
      indent,
      emitSteps(remembered, step.repeat.steps, `${path}.repeat.steps`, `${indent}  `),
    );
  }

  if (isForEach(step)) {
    return emitForEach(
      step,
      indent,
      emitSteps(step.failureContext ?? {}, step.steps, `${path}.steps`, `${indent}      `),
    );
  }

  if (isStage(step)) {
    return emitStage(remembered, step, indent);
  }

  return emitUse(remembered, step, indent, (outcome, branch) =>
    emitSteps(remembered, branch.steps, `${path}.on.${outcome}.steps`, `${indent}  `),
  );
};

// Each step under a comment naming where in the document it came from, which
// is how `tsc`'s word on this file finds its way back there.
const emitSteps: EmitSteps = (remembered, steps, path, indent) =>
  steps.flatMap((step, index) => [
    `${indent}// ${path}[${index}]`,
    ...emitStep(emitSteps, remembered, step, `${path}[${index}]`, indent),
  ]);

const emitSource = (source: FlowDocument["trigger"][number]) => {
  const input = Option.match(Option.fromUndefinedOr(source.with), {
    onNone: () => "",
    onSome: printJson,
  });

  return `sources[${printJson(source.use)}].find(${input})`;
};

// The blocks that claim the subject's issue, which its scope lets go however the run ends.
const CLAIMING = ["issue.claim", "hybrid.claim"];

// Where the flow's work comes from: its sources, or, for a flow a person
// starts, none, and the item lookup its subject gives.
const emitTrigger = (document: FlowDocument) => {
  if (document.start === true) {
    return ["  start: true,"];
  }

  return [
    "  sources: [",
    ...document.trigger.flatMap((source, index) => [
      `    // trigger[${index}]`,
      `    ${emitSource(source)},`,
    ]),
    "  ],",
  ];
};

const emit = (document: FlowDocument, sdk: string, stages: ReadonlyArray<string>) => {
  const blocks = [...new Set(usedIn(document.steps))];
  const staged = [...new Set(stagesIn(document.steps))];
  const subject = `subjects[${printJson(document.subject)}]`;

  // Each stage the document runs, for its input and output schemas, which type
  // its wires, from .chernabog/stages/ beside .chernabog/flows/.
  const stageImports = staged.flatMap((name) =>
    Option.toArray(stageFileOf(stages, name)).map(
      (file) => `import ${stageImport(name)} from ${printJson(`../stages/${file}`)};`,
    ),
  );

  const runStage = Option.getOrElse(
    Option.liftPredicate(" runStage,", () => staged.length > 0),
    () => "",
  );

  return [
    `// Generated from the flow document ${document.flow}; change the document, not this file.`,
    `import { Blocks, NeedsHuman } from ${printJson(sdk)};`,
    `import * as Effect from "effect/Effect";`,
    `import * as Option from "effect/Option";`,
    ...stageImports,
    "",
    `const { assemble, catalogue, laneScopes: lanes, loopStates,${runStage} sources, subjects } = Blocks;`,
    "",
    "export default assemble({",
    `  subject: ${printJson(document.subject)},`,
    ...Option.toArray(Option.fromUndefinedOr(document.gate)).map(
      (gate) => `  gate: ${printJson(gate)},`,
    ),
    ...Option.toArray(Option.fromUndefinedOr(document.concurrency)).map(
      (concurrency) => `  concurrency: ${concurrency},`,
    ),
    ...emitTrigger(document),
    "  // steps",
    `  blocks: ${printJson(blocks)},`,
    "  workflow: (item) =>",
    "    Effect.gen(function* () {",
    `      const trigger = yield* ${subject}.read(item);`,
    "",
    `      return yield* ${subject}.scope(trigger, { claims: ${blocks.some((block) => CLAIMING.includes(block))} }, (failureContext) =>`,
    "        Effect.gen(function* () {",
    ...emitSteps(document.failureContext ?? {}, document.steps, "steps", "          "),
    "        }),",
    "      );",
    "    }),",
    "});",
    "",
  ].join("\n");
};

// The flow file a document compiles to, or what is wrong with the document.
// `sdk` is where the file imports the SDK from, and `stages` the files in the
// repo's .chernabog/stages/.
export const generate = (
  document: FlowDocument,
  sdk = "@chernabog/sdk",
  stages: ReadonlyArray<string> = [],
) => {
  const problems = check(document, stages);

  if (problems.length > 0) {
    return Result.fail(problems);
  }

  return Result.succeed(emit(document, sdk, stages));
};
