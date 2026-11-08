// What a block is, and the values blocks pass each other, each typed by what it
// means. See blocks.ts for the blocks.

import {
  activity,
  describeError,
  type DoctorCheck,
  type FlowError,
  type FlowLabel,
  type Json,
  NeedsHuman,
  NothingCommitted,
  type Repo,
  Skip,
  StepFailed,
  StepRunner,
  type TriggeredFlow,
} from "@chernabog/core";
import * as Brand from "effect/Brand";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import * as Implement from "./implement.ts";
import type { FlowSettings } from "./settings.ts";

// What a scope's failures can tell a person beyond why: what the run got to.
export type FailureContext = { pr: Option.Option<PullRequestNumber> };

export type IssueNumber = number & Brand.Brand<"IssueNumber">;

export const IssueNumber = Brand.nominal<IssueNumber>();

export type PullRequestNumber = number & Brand.Brand<"PullRequestNumber">;

export const PullRequestNumber = Brand.nominal<PullRequestNumber>();

export type BranchName = string & Brand.Brand<"BranchName">;

export const BranchName = Brand.nominal<BranchName>();

export type BaseBranch = string & Brand.Brand<"BaseBranch">;

export const BaseBranch = Brand.nominal<BaseBranch>();

export type WorktreePath = string & Brand.Brand<"WorktreePath">;

export const WorktreePath = Brand.nominal<WorktreePath>();

// That the agent committed its work, that a branch was pushed, and that a
// review approved.
export class Committed extends Schema.TaggedClass<Committed, { readonly brand: "Committed" }>()(
  "Committed",
  {},
) {}

export class Pushed extends Schema.TaggedClass<Pushed, { readonly brand: "Pushed" }>()(
  "Pushed",
  {},
) {}

export class Approved extends Schema.TaggedClass<Approved, { readonly brand: "Approved" }>()(
  "Approved",
  {},
) {}

// A pull request a step can name, by the number it can only be.
export const pullRequestRef = <A extends Implement.PullRequestRef>(ref: A) => ({
  ...ref,
  number: PullRequestNumber(ref.number),
});

// Claim always settles a base; only a run claimed before bases resumes with none.
export const onBase = (base: Option.Option<BaseBranch>) =>
  Option.match(base, { onNone: () => ({}), onSome: (branch) => ({ base: branch }) });

// The line of work a step runs on beside others, which its step names carry:
// `implement#task-12`.
export type LaneId = string & Brand.Brand<"LaneId">;

export const LaneId = Brand.nominal<LaneId>();

export const inLane = (lane?: LaneId) =>
  Option.match(Option.fromUndefinedOr(lane), { onNone: () => ({}), onSome: (id) => ({ id }) });

// The agent session a lane's fixes resume, or this run's.
export const laneSession = (lane?: LaneId) =>
  Option.match(Option.fromUndefinedOr(lane), {
    onNone: () => Effect.succeed(Implement.thisRunsSession),
    onSome: (id) => Implement.sessionFor({ id }),
  });

// Any number of days, as a block's wait is written.
export type Days = `${number} days`;

// What a block's failure comes to:
// - person: a person is told why, and the enclosing scope ends needing them;
// - told: a person already knows, and the enclosing scope ends needing them;
// - skip: nothing is left to do, and the enclosing scope ends skipped;
// - fail: the enclosing scope ends failed.
export type Disposition = "person" | "told" | "skip" | "fail";

type Tagged = { readonly _tag: string };

type Tags<E> = E extends Tagged ? E["_tag"] : never;

export type Failures<E> = { readonly [Tag in Tags<E>]: Disposition };

// A block's failure on its way to a person. The scope around the blocks tells
// them, since what it can tell them depends on what the run got to.
export class ToPerson extends Schema.TaggedError<ToPerson, { readonly brand: "ToPerson" }>()(
  "ToPerson",
  { reason: Schema.String },
) {}

const reasonOf = (error: Tagged) => {
  // Each says why in its reason; its message, as an Error's, is empty.
  if (error instanceof NeedsHuman || error instanceof Skip) {
    return error.reason;
  }

  if (error instanceof NothingCommitted) {
    return `the agent finished without committing anything on ${error.branch}`;
  }

  return describeError(error);
};

const told = (error: Tagged) => {
  if (error instanceof NeedsHuman) {
    return error;
  }

  return new NeedsHuman({ reason: reasonOf(error) });
};

const skipped = (error: Tagged) => {
  if (error instanceof Skip) {
    return error;
  }

  return new Skip({ reason: reasonOf(error) });
};

const failed = (block: string, error: Tagged) => {
  if (error instanceof StepFailed) {
    return error;
  }

  return new StepFailed({ step: block, message: reasonOf(error) });
};

const settled = (block: string, error: Tagged, disposition: Disposition): FlowError | ToPerson => {
  switch (disposition) {
    case "person":
      return new ToPerson({ reason: reasonOf(error) });
    case "told":
      return told(error);
    case "skip":
      return skipped(error);
    case "fail":
      return failed(block, error);
  }
};

// The fields of a flow's settings a block reads, none of which needs a service.
export type SettingsFields = {
  readonly [key: string]: Schema.Top & {
    readonly DecodingServices: never;
    readonly EncodingServices: never;
  };
};

// What using a block adds to its flow, unasked.
export type Contribution = {
  readonly settings?: SettingsFields;
  readonly labels?: ReadonlyArray<FlowLabel>;
  // Labels named by the flow's settings, as a repo may rename them.
  readonly namedLabels?: ReadonlyArray<Effect.Effect<FlowLabel, never, FlowSettings | Repo>>;
  readonly doctor?: ReadonlyArray<DoctorCheck>;
  // Finds runs of this flow parked in the block, to wake them.
  readonly wakes?: TriggeredFlow["trigger"];
  readonly ownWork?: boolean;
};

const DispositionTable = Schema.Record(
  Schema.String,
  Schema.Literals(["person", "told", "skip", "fail"]),
);

const InputNeeds = Schema.Record(Schema.String, Schema.Literals(["required", "optional"]));

const dispositionsOf = Schema.decodeUnknownSync(DispositionTable);

const inputNeedsOf = Schema.decodeUnknownSync(InputNeeds);

const Kinds = Schema.Record(Schema.String, Schema.String);

const kindsOf = Schema.decodeUnknownSync(Kinds);

const outputKindsOf = Schema.decodeUnknownSync(Schema.Union([Schema.String, Kinds]));

const opensOf = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Array(Schema.String)));

// What a block gives, as a listing says it: a word for a value, or a word for
// each field. It must name every field the block's output has, and no others.
type OutputKinds<Output> = [Output] extends [string | number | boolean | void]
  ? string
  : { readonly [Field in keyof Output]-?: string };

type BlockSpec<Input, Output, E, R, Outcomes> = {
  readonly name: string;
  // What it does, for someone choosing blocks.
  readonly about: string;
  // What each input takes, each output gives and each outcome binds, for the
  // same. The compiler makes these name exactly what the block has.
  readonly inputKinds: { readonly [Name in keyof Input]-?: string };
  readonly outputKinds: OutputKinds<NoInfer<Output>>;
  readonly outcomeKinds: { readonly [Name in keyof NoInfer<Outcomes>]: string };
  // The inputs a document gives as a fixed value, under `with`, rather than
  // wiring them to an earlier step's output, under `in`.
  readonly fixed?: ReadonlyArray<keyof Input & string>;
  // The inputs a document may give either way: a fixed value under `with`, or
  // an earlier step's output under `in`.
  readonly either?: ReadonlyArray<keyof Input & string>;
  // The blocks that, on a path with both, must run after this one.
  readonly before?: ReadonlyArray<string>;
  // The blocks that must already have run on any path to this one.
  readonly needs?: ReadonlyArray<string>;
  // What this leaves to be done on any path that goes on to finish well, and
  // what it does of that. A path that ends with a person is excused.
  readonly opens?: ReadonlyArray<string>;
  readonly closes?: ReadonlyArray<string>;
  // What taking an outcome leaves to be done, the same way.
  readonly opensOn?: { readonly [Name in keyof NoInfer<Outcomes>]?: ReadonlyArray<string> };
  // Each input and whether a document must wire it. An input it needn't wire
  // has a default.
  readonly inputs: { readonly [Name in keyof Input]-?: "required" | "optional" };
  readonly run: (input: Input) => Effect.Effect<Output, E, R>;
  readonly failures: Failures<NoInfer<E>>;
  // The branches a document can take on the block's output, each the value it
  // binds there, or none when the output didn't take it.
  readonly outcomes: Outcomes;
  // The outcomes a document must say what to do about.
  readonly mustRoute: ReadonlyArray<keyof Outcomes & string>;
  // Whether the block waits, so a loop through it doesn't spin.
  readonly waits?: boolean;
  // Whether it runs only on a run's way out: in a repeat, no way past it goes
  // on to another round, which a document is checked for, so it runs once and
  // its steps needn't carry the round.
  readonly last?: boolean;
  // The outcomes that changed something, so a loop taking one doesn't spin.
  readonly progressOn?: ReadonlyArray<keyof Outcomes & string>;
  // The outcome it comes to when it changed nothing: any other way past it,
  // a loop doesn't spin.
  readonly progressUnless?: keyof Outcomes & string;
  // Whether every run comes to one of the outcomes, so a document whose
  // branches all end has nothing after the block.
  readonly exhaustive?: boolean;
  // The groups of step names its run uses that another block's also does, or
  // its own name when none are shared, and none for a block that runs no step.
  // A second use of a step name replays the first's result instead of doing
  // the work, so no path takes a group twice, and a block that runs steps in a
  // loop's rounds or beside others must carry the round or the lane in them.
  readonly stepNames?: ReadonlyArray<string>;
  // The subjects it suits, for a block whose inputs can't show them: one that
  // reads its run's work item itself, or leans on what only a subject's scope
  // does, such as letting its claim go. It suits none of the others, even
  // where what it takes could be wired; see suits.ts.
  readonly suits?: ReadonlyArray<string>;
  readonly contributes: Contribution;
};

// Where a flow's work comes from.
export type Source = {
  readonly trigger: TriggeredFlow["trigger"];
  readonly contributes: Contribution;
};

// A source, by the name a document uses it by, and the subject of the work
// items it finds.
export const defineSource = <Subject extends string, Input extends ReadonlyArray<unknown>>(
  name: string,
  subject: Subject,
  find: (...input: Input) => Source,
) => ({ name, subject, find });

type Named = { readonly [key: string]: { readonly name: string } };

// What a document can use by name, gathered from the files that define it, a
// file at a time. Spreading the files together would let a later file's entry
// quietly replace an earlier one's, so a document compiled against a block its
// author didn't mean; a name defined twice, or kept under a key other than its
// own, is refused instead, when the module loads.
export type Gathered<Entries> = {
  readonly entries: Entries;
  readonly and: <More extends Named>(file: string, more: More) => Gathered<Entries & More>;
};

// What a catalogue gets wrong, refused the way a block's tables are: by
// decoding, when the module loads.
const refuseMistakes = Schema.decodeUnknownSync(
  Schema.Array(Schema.String).pipe(
    Schema.check(
      Schema.makeFilter(
        (mistakes: ReadonlyArray<string>) => mistakes.length === 0 || mistakes.join("; "),
      ),
    ),
  ),
);

const gatherOnto = <Before extends Named, Entries extends Named>(
  kind: string,
  where: ReadonlyMap<string, string>,
  before: Before,
  file: string,
  entries: Entries,
): Gathered<Before & Entries> => {
  const found = new Map(where);
  const mistakes: Array<string> = [];

  for (const [key, entry] of Object.entries(entries)) {
    if (entry.name !== key) {
      mistakes.push(
        `${kind} "${key}" in ${file} is named "${entry.name}"; its key must be its name`,
      );
    }

    const earlier = Option.fromUndefinedOr(found.get(key));

    if (Option.isSome(earlier)) {
      mistakes.push(`${kind} "${key}" is defined twice: in ${earlier.value} and in ${file}`);
    }

    found.set(key, file);
  }

  refuseMistakes(mistakes);

  const all = { ...before, ...entries };

  return {
    entries: all,
    and: (next, more) => gatherOnto(kind, found, all, next, more),
  };
};

export const gather = <Entries extends Named>(kind: string, file: string, entries: Entries) =>
  gatherOnto(kind, new Map(), {}, file, entries);

export const defineBlock = <
  Input,
  Output,
  E extends Tagged,
  R,
  const Outcomes extends {
    readonly [Name in string]: (output: Output) => Option.Option<unknown>;
  },
>(
  spec: BlockSpec<Input, Output, E, R, Outcomes>,
) => {
  const table = dispositionsOf(spec.failures);

  return {
    name: spec.name,
    failures: table,
    about: spec.about,
    inputKinds: kindsOf(spec.inputKinds),
    outputKinds: outputKindsOf(spec.outputKinds),
    outcomeKinds: kindsOf(spec.outcomeKinds),
    fixed: (spec.fixed ?? []).map(String),
    either: (spec.either ?? []).map(String),
    before: spec.before ?? [],
    needs: spec.needs ?? [],
    opens: spec.opens ?? [],
    closes: spec.closes ?? [],
    opensOn: opensOf(spec.opensOn ?? {}),
    inputs: inputNeedsOf(spec.inputs),
    outcomes: spec.outcomes,
    mustRoute: spec.mustRoute,
    exhaustive: spec.exhaustive === true,
    waits: spec.waits === true,
    last: spec.last === true,
    progressOn: spec.progressOn ?? [],
    progressUnless: Option.fromUndefinedOr(spec.progressUnless),
    stepNames: spec.stepNames ?? [spec.name],
    suits: Option.fromUndefinedOr(spec.suits),
    contributes: spec.contributes,
    run: (input: Input, overrides: Partial<Failures<NoInfer<E>>> = {}) => {
      const own = dispositionsOf(overrides);

      return spec.run(input).pipe(
        Effect.mapError((error) =>
          settled(
            spec.name,
            error,
            Option.getOrElse(
              Option.orElse(Record.get(own, error._tag), () => Record.get(table, error._tag)),
              (): Disposition => "fail",
            ),
          ),
        ),
      );
    },
  };
};

// What a document says each failure of a stage means: a stage has no table of
// its own. Exit 78 is Skip; any other failure is StepFailed.
export type StageFailures = { readonly Skip: Disposition; readonly StepFailed: Disposition };

// What names a stage's step beside its name: the round of a loop it runs in,
// `find-work-2`, or the lane, `find-work#task-12`.
export type StageKey = { readonly round?: number; readonly lane?: LaneId };

const stageStep = (name: string, key: StageKey) =>
  [
    name,
    ...Option.toArray(Option.fromUndefinedOr(key.round)).map((round) => `-${round}`),
    ...Option.toArray(Option.fromUndefinedOr(key.lane)).map((lane) => `#${lane}`),
  ].join("");

const stageDisposition = (failures: StageFailures, error: FlowError): Disposition => {
  if (error instanceof Skip) {
    return failures.Skip;
  }

  if (error instanceof StepFailed) {
    return failures.StepFailed;
  }

  // A stage's process can't ask for a person; an activity's own can.
  return "told";
};

// Runs a step of the repo's own from .chernabog/stages/, as a document does:
// its input, typed by the stage's schema, crosses to its process as JSON, and
// what it prints comes back checked against its output schema. Each failure
// comes to what the document says.
export const runStage = <I, O>(
  name: string,
  stage: { readonly input: Schema.Codec<I, Json>; readonly output: Schema.Codec<O, Json> },
  input: NoInfer<I>,
  failures: StageFailures,
  key: StageKey,
) =>
  activity(
    stageStep(name, key),
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(stage.input)(input).pipe(
        Effect.mapError(
          (issue) => new StepFailed({ step: name, message: `input: ${issue.message}` }),
        ),
      );

      const raw = yield* StepRunner.use((runner) => runner.run(name, encoded));

      return yield* Schema.decodeEffect(stage.output)(raw).pipe(
        Effect.mapError(
          (issue) => new StepFailed({ step: name, message: `output: ${issue.message}` }),
        ),
      );
    }),
    stage.output,
  ).pipe(Effect.mapError((error) => settled(name, error, stageDisposition(failures, error))));
