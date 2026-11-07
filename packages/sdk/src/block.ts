// What a block is, and the values blocks pass each other, each typed by what it
// means. See blocks.ts for the blocks.

import {
  describeError,
  type DoctorCheck,
  type FlowError,
  type FlowLabel,
  NeedsHuman,
  NothingCommitted,
  Skip,
  StepFailed,
  type TriggeredFlow,
} from "@chernabog/core";
import * as Brand from "effect/Brand";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import * as Implement from "./implement.ts";

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

type BlockSpec<Input, Output, E, R, Outcomes> = {
  readonly name: string;
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
  readonly contributes: Contribution;
};

// Where a flow's work comes from.
export type Source = {
  readonly trigger: TriggeredFlow["trigger"];
  readonly contributes: Contribution;
};

// A source, and the subject of the work items it finds.
export const defineSource = <Subject extends string, Input extends ReadonlyArray<unknown>>(
  subject: Subject,
  find: (...input: Input) => Source,
) => ({ subject, find });

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
    inputs: inputNeedsOf(spec.inputs),
    outcomes: spec.outcomes,
    mustRoute: spec.mustRoute,
    exhaustive: spec.exhaustive === true,
    waits: spec.waits === true,
    progressOn: spec.progressOn ?? [],
    progressUnless: Option.fromUndefinedOr(spec.progressUnless),
    stepNames: spec.stepNames ?? [spec.name],
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
