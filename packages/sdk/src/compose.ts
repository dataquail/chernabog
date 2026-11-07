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
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as SchemaIssue from "effect/SchemaIssue";

import { catalogue, laneScopes, loopStates, sources, subjects } from "./blocks.ts";

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
  readonly in?: { readonly [input: string]: string };
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
    in: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
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
// its form and where.
export const read = (value: Schema.Json): Result.Result<FlowDocument, ReadonlyArray<Problem>> =>
  Result.mapError(decodeDocument(value), (error) =>
    Option.toArray(mismatchOf(error.issue, [])).map(({ keys, message }) => ({
      path: pathTo(keys),
      message,
    })),
  );

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
  checkSteps(checking)(document.steps, "steps", new Set(["trigger"]), new Map(), {
    inLoop: false,
    inLane: false,
  });
  checkFailureContext(checking, document, subject.value.failureContext);

  return checking.problems;
};

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
    ...Object.entries(step.in ?? {}),
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
    "  sources: [",
    ...document.trigger.flatMap((source, index) => [
      `    // trigger[${index}]`,
      `    ${emitSource(source)},`,
    ]),
    "  ],",
    "  // steps",
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
