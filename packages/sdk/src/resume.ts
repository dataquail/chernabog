// How a run of a flow document takes up an item where a run before it parked
// (ADR 0021, decision 4). A run ends at every park, so a document that waits
// on CI records the wait, and the next run starts at the node that recorded
// it rather than at the top.
//
// The record's data names the node (`resume.node`), not just the phase: one
// phase can be recorded at several nodes, as implement's two waits for CI both
// record awaiting-ci on the issue. With the node it keeps the run's work item,
// the persona that parked it, and the outputs of the steps before it that the
// steps from that node on read (`kept`), which the compiler works out. A step
// can be kept only when its block says how its output goes into JSON
// (Block.keeps). A run that takes the item up restores those outputs and goes
// on from the node, so nothing before it, such as the agent's work, runs again.
//
// What a node keeps must fit the record's 4 KB. When it doesn't, the block
// waits inside the run, as it did before a record could carry anything: it
// polls.

import {
  activity,
  Claims,
  type FlowError,
  GitHub,
  isPhaseData,
  type Json,
  type PhaseData,
  Skip,
  StepFailed,
  type TriggerServices,
  type WorkItem,
} from "@chernabog/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import * as Phases from "./phases.ts";

type JsonObject = { readonly [key: string]: Json };

const isJsonObject = (json: Json): json is JsonObject =>
  Predicate.isObject(json) && !Array.isArray(json);

// What a block says of how its output goes into a record, and back.
type Keeps<Kept> = { readonly keeps: Option.Option<Schema.Codec<Kept, Json>> };

// A step's output as a record keeps it: none for a block that can't say, or
// an output its codec refuses.
export const keep = <Kept, Output extends Kept>(block: Keeps<Kept>, output: Output) =>
  Option.flatMap(block.keeps, (codec) => Schema.encodeOption(codec)(output));

// What a document passes the block at a node it can resume at: the flow, the
// run's work item, the node, and each kept step's output as JSON. At the node
// a run resumed at, `resumed` is the phase the record it resumed from held,
// for the block to go on from (a wait for CI's round).
export type Keep = {
  readonly flow: string;
  readonly item: WorkItem;
  readonly node: string;
  readonly kept: { readonly [name: string]: Option.Option<Json> };
  readonly resumed: Option.Option<string>;
};

// The node a block runs at, when its document can resume there; none in a
// recipe, or at a node a document can't resume at.
export const Keeping = Context.Reference<Option.Option<Keep>>("@chernabog/sdk/Keeping", {
  defaultValue: () => Option.none(),
});

// Runs a block at a node its document can resume at.
export const keeping =
  (found: Keep) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Keeping, Option.some(found));

// The work item a record keeps, as the run that parked had it.
const KeptItem = Schema.Struct({
  key: Schema.String,
  title: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  data: Schema.Json,
});

// What a record at a node a document resumes at keeps, under `resume`.
const Parked = Schema.Struct({
  resume: Schema.Struct({
    flow: Schema.String,
    node: Schema.String,
    login: Schema.String,
    item: KeptItem,
    kept: Schema.Record(Schema.String, Schema.Json),
  }),
});

type Parked = typeof Parked.Type;

// What a work item that resumes a document carries, under `resume`: the node,
// the phase its record held, and the kept outputs.
const Resumed = Schema.Struct({
  node: Schema.String,
  phase: Schema.String,
  kept: Schema.Record(Schema.String, Schema.Json),
});

export type Resumed = typeof Resumed.Type;

const ResumingItem = Schema.Struct({ resume: Resumed });

// Where a run takes its document up: the node and what was kept, for a work
// item from a parked record; none for any other.
export const resumedAt = (item: WorkItem): Option.Option<Resumed> =>
  Option.map(Schema.decodeUnknownOption(ResumingItem)(item.data), (data) => data.resume);

// A kept step's output, typed by its block's codec: a step that fails when the
// record holds no output for it, or one the codec refuses.
export const kept = <Kept>(resumed: Resumed, name: string, block: Keeps<Kept>) =>
  Effect.gen(function* () {
    const output = Option.flatMap(Record.get(resumed.kept, name), (json) =>
      Option.flatMap(block.keeps, (codec) => Schema.decodeOption(codec)(json)),
    );

    if (Option.isNone(output)) {
      return yield* new StepFailed({
        step: `resume-${resumed.node}`,
        message: `the record parked at ${resumed.node} keeps no ${name} this flow can read`,
      });
    }

    return output.value;
  });

// The value an outcome bound before the node, worked out again from its
// step's kept output: the run parked in that outcome's branch, so it holds.
export const outcome = <A>(resumed: Resumed, name: string, found: Option.Option<A>) =>
  Effect.gen(function* () {
    if (Option.isNone(found)) {
      return yield* new StepFailed({
        step: `resume-${resumed.node}`,
        message: `the record parked at ${resumed.node} keeps a step that no longer comes to ${name}`,
      });
    }

    return found.value;
  });

// The work item's data as the run that parked it was given it, without what
// a resumed run's item adds.
const itemData = (item: WorkItem): Json =>
  Option.match(Option.liftPredicate(item.data, isJsonObject), {
    onNone: () => item.data,
    onSome: (data) => Record.remove(data, "resume"),
  });

const keptItem = (item: WorkItem) => ({
  key: item.key,
  ...Option.match(Option.fromUndefinedOr(item.title), {
    onNone: () => ({}),
    onSome: (title) => ({ title }),
  }),
  ...Option.match(Option.fromUndefinedOr(item.url), {
    onNone: () => ({}),
    onSome: (url) => ({ url }),
  }),
  data: itemData(item),
});

// Where a block at a resumable node records its wait, and the data, with its
// own beside: none outside a document's resumable node, or when what the node
// keeps can't go into a record, and the block waits inside the run.
export const parking = (own: JsonObject = {}) =>
  Effect.gen(function* () {
    const found = yield* Keeping;
    const on = yield* Phases.RecordedOn;

    if (Option.isNone(found)) {
      return Option.none<{ readonly item: string; readonly data: PhaseData }>();
    }

    const login = yield* GitHub.use((github) => github.login).pipe(Effect.option);

    const data = Option.flatMap(
      Option.all({ values: Option.all(found.value.kept), who: login }),
      ({ values, who }) =>
        Option.liftPredicate(
          {
            ...own,
            resume: {
              flow: found.value.flow,
              node: found.value.node,
              login: who,
              item: keptItem(found.value.item),
              kept: values,
            },
          },
          isPhaseData,
        ),
    );

    return Option.all({ item: on, data });
  });

// The phase a run resumed from, at the node it resumed at; none anywhere else.
export const resumedPhase = Effect.map(Keeping, (found) =>
  Option.flatMap(found, (at) => at.resumed),
);

// A resumed run claims its item again, as the run that parked held it until
// it ended: on the item it records on, which for an issue is its claim's.
export const claimAgain = Effect.gen(function* () {
  const on = yield* Phases.RecordedOn;

  for (const item of Option.toArray(on)) {
    yield* activity(
      "claim-again",
      Effect.gen(function* () {
        const claimed = yield* Claims.acquire(item);

        if (!claimed.acquired) {
          return yield* new Skip({
            reason: `${item} is already claimed (${Claims.describeHolder(item, claimed.holder)})`,
          });
        }
      }),
    );
  }
});

// How a block at a resumable node says whether its item may start again:
// the item, held with why while what it waits on hasn't settled, or none
// when there is nothing left to resume, as for a pull request closed since.
export type Resumes = (
  data: PhaseData,
  item: WorkItem,
) => Effect.Effect<Option.Option<WorkItem>, FlowError, TriggerServices>;

const sameLogin = (one: string, other: string) => one.toLowerCase() === other.toLowerCase();

const decodeParked = Schema.decodeUnknownOption(Parked);

// The item a parked record offers, as its run had it, carrying where to resume.
const resumingItem = (record: Parked, phase: string): Option.Option<WorkItem> =>
  Option.map(Option.liftPredicate(record.resume.item.data, isJsonObject), (data) => ({
    ...record.resume.item,
    data: {
      ...data,
      resume: { node: record.resume.node, phase, kept: record.resume.kept },
    },
  }));

// The source a document that can resume gets: items whose record says one of
// its runs parked at one of its nodes, as work a run may start, never only a
// wake (ADR 0021, decision 4). Each node's block says whether its item may
// start yet (`nodes`). One parked by another persona is left for it; one
// parked at a node the document no longer has is held, with why, for a
// person to see in status.
export const parked = (flow: string, nodes: { readonly [node: string]: Resumes }) =>
  Effect.gen(function* () {
    const login = yield* GitHub.use((github) => github.login);
    const items: Array<WorkItem> = [];

    for (const [, found] of yield* Phases.records) {
      const ours = Option.filter(
        Option.flatMap(found.data, decodeParked),
        (record) => record.resume.flow === flow,
      );

      for (const [record, data] of Option.toArray(Option.all([ours, found.data]))) {
        for (const item of Option.toArray(resumingItem(record, found.phase))) {
          const resumes = Record.get(nodes, record.resume.node);

          if (Option.isNone(resumes)) {
            items.push({
              ...item,
              held: `parked at ${record.resume.node}, a step ${flow} no longer has`,
            });

            continue;
          }

          if (!sameLogin(record.resume.login, login)) {
            items.push({ ...item, elsewhere: `parked by ${record.resume.login}` });

            continue;
          }

          for (const ready of Option.toArray(yield* resumes.value(data, item))) {
            items.push(ready);
          }
        }
      }
    }

    return items;
  });
