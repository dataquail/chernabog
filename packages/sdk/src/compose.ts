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
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  catalogue,
  laneScopes,
  loopStates,
  sourceDescriptions,
  sources,
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
  // Runs only when the named boolean output is true. Its output is then
  // optional, and `first` joins it with what stands in for it.
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

export type Step = UseStep | EndStep | RepeatStep | NextStep | ForEachStep | FirstStep;

const EndStep = Schema.Union([
  Schema.Struct({ end: Schema.Literal("done"), summary: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ end: Schema.Literal("needs-human"), reason: Schema.String }),
]);

const Steps = Schema.Array(Schema.suspend((): Schema.Codec<Step> => Step));

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
    on: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.Struct({
          as: Schema.optionalKey(Schema.String),
          steps: Steps,
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

const decodeDocument = Schema.decodeUnknownResult(FlowDocument);

type JsonObject = { readonly [key: string]: Schema.Json };

const isObject = (value: Schema.Json): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

const FORMAT_HINT = "chernabog recipes blocks shows the format.";

const STEP_KINDS = "use (a block, with an id), end, next, first, repeat or forEach";

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
  const kinds = ["use", "end", "next", "first", "repeat", "forEach"].filter((key) => key in step);

  if (kinds.length === 0) {
    return [{ path: at, message: `must be a step: ${STEP_KINDS}` }];
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

  const missing = ["flow", "subject", "trigger", "steps"].flatMap((key): ReadonlyArray<Problem> => {
    if (key in value) {
      return [];
    }

    return [{ path: "", message: `must say ${key}. ${FORMAT_HINT}` }];
  });

  return [
    ...missing,
    ...Option.match(fieldOf(value, "steps"), {
      onNone: () => [],
      onSome: (steps) => stepsAt(Option.some(steps), "steps"),
    }),
  ];
};

// A document's form, or what is wrong with it and where: whatever a parser made
// of its text.
export const read = (value: Schema.Json): Result.Result<FlowDocument, ReadonlyArray<Problem>> => {
  const problems = documentProblems(value);

  if (problems.length > 0) {
    return Result.fail(problems);
  }

  return Result.mapError(decodeDocument(value), (error) => [
    { path: "", message: `${error.message}. ${FORMAT_HINT}` },
  ]);
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

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

const isNext = (step: Step): step is NextStep => "next" in step;

export const isRepeat = (step: Step): step is RepeatStep => "repeat" in step;

export const isForEach = (step: Step): step is ForEachStep => "forEach" in step;

const isFirst = (step: Step): step is FirstStep => "first" in step;

const rootOf = (reference: string) => reference.split(".")[0];

const branchesOf = (step: UseStep): ReadonlyArray<readonly [string, Branch]> =>
  Object.entries(step.on ?? {});

const inside = (step: Step): ReadonlyArray<Step> => {
  if (isRepeat(step)) {
    return step.repeat.steps;
  }

  if (isForEach(step)) {
    return step.steps;
  }

  if (isUse(step)) {
    return branchesOf(step).flatMap(([, branch]) => branch.steps);
  }

  return [];
};

const boundBy = (step: Step): ReadonlyArray<string> => {
  if (!isUse(step)) {
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
};

type Block = (typeof catalogue)[keyof typeof catalogue];

type Subject = (typeof subjects)[keyof typeof subjects];

const blocksByName: { readonly [name: string]: Block } = catalogue;

const subjectsByName: { readonly [name: string]: Subject } = subjects;

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
    } else if (!fixed.includes(input)) {
      say(
        checking,
        `${at}.with.${input}`,
        `${input} comes from an earlier step: put it under in, as step or step.field`,
      );
    }
  }
};

const checkIdentity = (
  checking: Checking,
  step: UseStep,
  names: ReadonlySet<string>,
  used: ReadonlySet<string>,
  at: string,
) => {
  if (!IDENTIFIER.test(step.id) || RESERVED.has(step.id)) {
    say(checking, `${at}.id`, `${step.id} can't name a step`);
  }

  if (names.has(step.id)) {
    say(checking, `${at}.id`, `${step.id} is already a step here`);
  }

  // A run resumes by its step names, which a block's two uses would share.
  if (used.has(step.use)) {
    say(
      checking,
      `${at}.use`,
      `${step.use} runs twice on one path, and its step names would collide`,
    );
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

type Walked = { readonly ends: boolean; readonly seen: ReadonlySet<string> };

// Where a walk is: inside a repeat, `next` means something, and inside a lane,
// a block that can carry a lane must, or two lanes' steps would collide.
type Place = { readonly inLoop: boolean; readonly inLane: boolean };

const checkLaneWire = (
  checking: Checking,
  step: UseStep,
  block: Block,
  place: Place,
  at: string,
) => {
  if (place.inLane && "lane" in block.inputs && !("lane" in (step.in ?? {}))) {
    say(checking, `${at}.in`, `${step.use} runs beside others here, and must name its lane`);
  }
};

// A way round a loop that neither waits nor changes anything would spin.
const checkSpin = (
  checking: Checking,
  steps: ReadonlyArray<Step>,
  waited: boolean,
  path: string,
): void => {
  let settled = waited;

  for (const [index, step] of steps.entries()) {
    const at = `${path}[${index}]`;

    if (isNext(step) && !settled) {
      say(checking, at, "this round neither waits nor changes anything, so the loop would spin");
    }

    if (isForEach(step)) {
      settled = true;
    }

    if (isUse(step)) {
      const found = Record.get(blocksByName, step.use);

      const progressOn: ReadonlyArray<string> = Option.match(found, {
        onNone: () => [],
        onSome: (block) => block.progressOn,
      });

      for (const [outcome, branch] of branchesOf(step)) {
        const walked = settled || Option.exists(found, (block) => block.waits);

        checkSpin(
          checking,
          branch.steps,
          walked || progressOn.includes(outcome),
          `${at}.on.${outcome}.steps`,
        );
      }

      settled = settled || Option.exists(found, (block) => block.waits);
    }
  }
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
  seen: ReadonlySet<string>,
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

  // A lane's steps carry its id, so each lane's names are its own.
  walk(step.steps, `${at}.steps`, new Set([...names, step.as]), new Set(), {
    inLoop: false,
    inLane: true,
  });
};

// What a block's step left: whether every run ends in it.
const checkUse = (
  checking: Checking,
  step: UseStep,
  names: Set<string>,
  used: Set<string>,
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

  checkIdentity(checking, step, names, used, at);
  used.add(step.use);
  checkInputs(checking, step, block, names, at);
  checkRouting(checking, step, block, at);
  checkLaneWire(checking, step, block, place, at);

  for (const flag of Option.toArray(Option.fromUndefinedOr(step.if))) {
    checkReference(checking, names, flag, `${at}.if`);
  }

  names.add(step.id);

  const walked = branchesOf(step).map(([outcome, branch]) =>
    walk(
      branch.steps,
      `${at}.on.${outcome}.steps`,
      new Set([...names, ...Option.toArray(Option.fromUndefinedOr(branch.as))]),
      used,
      place,
    ),
  );

  // A branch that doesn't end carries on into what follows, with what it used.
  for (const each of walked.filter((branch) => !branch.ends).flatMap((one) => [...one.seen])) {
    used.add(each);
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
    const used = new Set(seen);

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
        checkLoop(checking, step, at);

        // A round's steps carry its number, so each round's names are its own.
        walk(
          step.repeat.steps,
          `${at}.repeat.steps`,
          new Set([...names, "round", "state"]),
          new Set(),
          {
            ...place,
            inLoop: true,
          },
        );

        return stopsAt(index);
      }

      if (isFirst(step)) {
        for (const reference of step.first) {
          checkReference(checking, names, reference, `${at}.first`);
        }
      }

      if (isForEach(step)) {
        checkForEach(checking, step, names, walk, at);
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
      if (!declared.has(rootOf(reference))) {
        say(checking, `failureContext.${field}`, `no step named ${rootOf(reference)} sets it`);
      }
    }
  }
};

// Goes down every way through the steps, and says where a block's order is
// broken, or a way that finishes well leaves something it should have done.
type Ordering = {
  readonly say: (path: string, message: string) => void;
};

type Placed = { readonly step: Step; readonly at: string };

type Way = {
  readonly seen: ReadonlyArray<string>;
  // What is left to do, and the block that left it.
  readonly open: ReadonlyMap<string, string>;
  // Where the steps walked end, for a way that runs off them; none in a round,
  // which runs on into the next.
  readonly endsAt: Option.Option<string>;
};

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

  for (const earlier of needs.filter((each) => !way.seen.includes(each))) {
    ordering.say(at, `${step.use} needs ${earlier} to have run first`);
  }

  const closes: ReadonlyArray<string> = block.closes;
  const opens: ReadonlyArray<string> = block.opens;

  return {
    ...way,
    seen: [...way.seen, step.use],
    open: new Map([
      ...[...way.open].filter(([what]) => !closes.includes(what)),
      ...opens.map((what) => [what, step.use] as const),
    ]),
  };
};

const walkOrder = (ordering: Ordering, items: ReadonlyArray<Placed>, way: Way): void => {
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

  if (isNext(step)) {
    return;
  }

  if (isRepeat(step)) {
    walkOrder(ordering, placed(step.repeat.steps, `${at}.repeat.steps`), {
      ...way,
      endsAt: Option.none(),
    });

    return;
  }

  if (isForEach(step)) {
    // A lane ends for itself, with what it left to do its own.
    walkOrder(ordering, placed(step.steps, `${at}.steps`), {
      seen: way.seen,
      open: new Map(),
      endsAt: Option.some(`${at}.steps`),
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
    },
    placed(document.steps, "steps"),
    { seen: [], open: new Map(), endsAt: Option.some("steps") },
  );
};

const checkTrigger = (checking: Checking, document: FlowDocument) => {
  const names = Object.keys(sources);

  if (document.trigger.length === 0) {
    say(checking, "trigger", "must name where the flow's work comes from");
  }

  for (const [index, source] of document.trigger.entries()) {
    if (!names.includes(source.use)) {
      say(checking, `trigger[${index}].use`, `must be one of ${names.join(", ")}`);
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

  checkTrigger(checking, document);
  checkSteps(checking)(document.steps, "steps", new Set(["trigger"]), new Set(), {
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

Add if: <step.field>, a boolean output, to run a step only sometimes. Its output is then optional, and { id: x, first: [maybeRan, standIn] } gives the first that ran.

{ id: rounds, repeat: { state: { <name>: <a loop state> }, steps: [...] } } loops: its steps have round and state.<name>, and { next: { <name>: <reference> } } starts the next round with that state changed. Some way must end the loop, and every way round must wait or change something.

{ id: x, forEach: <list>, as: item, scope: <a lane scope>, atOnce: <number output>, steps: [...] } runs its steps once per item, beside each other; blocks there wire lane.`;

// Everything a document can use, for an agent or a person composing one.
export const describe = (): Schema.Json => ({
  format: FORMAT,
  subjects: Object.entries(subjects).map(([name, subject]) => ({
    name,
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
        Option.liftPredicate("with", () => block.fixed.includes(name)),
        () => "in",
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
      `${indent}const ${step.id} = ${flag} ? Option.some(${call}) : Option.none();`,
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

  return `sources[${printJson(source.use)}](${input})`;
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
    "const { assemble, catalogue, laneScopes: lanes, loopStates, sources, subjects } = Blocks;",
    "",
    "export default assemble({",
    `  subject: ${printJson(document.subject)},`,
    ...Option.toArray(Option.fromUndefinedOr(document.gate)).map(
      (gate) => `  gate: ${printJson(gate)},`,
    ),
    ...Option.toArray(Option.fromUndefinedOr(document.concurrency)).map(
      (concurrency) => `  concurrency: ${concurrency},`,
    ),
    "  // trigger",
    `  sources: [${document.trigger.map(emitSource).join(", ")}],`,
    `  blocks: ${printJson(blocks)},`,
    "  workflow: (item) =>",
    "    Effect.gen(function* () {",
    `      const trigger = yield* ${subject}.read(item);`,
    "",
    `      return yield* ${subject}.scope(trigger, { claims: ${blocks.includes("issue.claim")} }, (failureContext) =>`,
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
// `sdk` is where the file imports the SDK from.
export const generate = (document: FlowDocument, sdk = "@chernabog/sdk") => {
  const problems = check(document);

  if (problems.length > 0) {
    return Result.fail(problems);
  }

  return Result.succeed(emit(document, sdk));
};
