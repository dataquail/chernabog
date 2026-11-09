// An in-memory adapter of core's Progress port, for tests: each item's
// record in a map, an advance a compare-and-set on it. It passes the contract
// every adapter must (test/progress-contract.ts).

import {
  type Phase,
  PhaseMoved,
  type PhaseRecord,
  type PhaseTransition,
  type Progress,
} from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

type Store = { readonly records: ReadonlyMap<string, PhaseRecord>; readonly written: number };

const phaseOf = (record: Option.Option<PhaseRecord>): Option.Option<Phase> =>
  Option.map(record, (found) => found.phase);

// The record is this transition, by this writer: a retry of a write that landed.
const isOwn = (record: PhaseRecord, transition: PhaseTransition) =>
  record.by === transition.by &&
  record.phase === transition.to &&
  Equal.equals(record.from, transition.from);

// What advancing `item` by `transition` does to `store`, all in one step.
const advancing =
  (item: string, transition: PhaseTransition) =>
  (store: Store): [Result.Result<PhaseRecord, PhaseMoved>, Store] => {
    const current = Option.fromUndefinedOr(store.records.get(item));
    const own = Option.filter(current, (record) => isOwn(record, transition));

    if (Option.isSome(own)) {
      return [Result.succeed(own.value), store];
    }

    if (!Equal.equals(phaseOf(current), transition.from)) {
      return [
        Result.fail(new PhaseMoved({ item, expected: transition.from, found: phaseOf(current) })),
        store,
      ];
    }

    const written = store.written + 1;

    const record: PhaseRecord = {
      phase: transition.to,
      from: transition.from,
      by: transition.by,
      version: `v${written}`,
    };

    return [
      Result.succeed(record),
      { records: new Map([...store.records, [item, record]]), written },
    ];
  };

// A fresh fake, holding no records, each time it runs.
export const progressFake: Effect.Effect<Progress["Service"]> = Effect.map(
  Ref.make<Store>({ records: new Map(), written: 0 }),
  (store) => ({
    read: (item) =>
      Effect.map(Ref.get(store), ({ records }) => Option.fromUndefinedOr(records.get(item))),
    readAll: Effect.map(Ref.get(store), ({ records }) => records),
    advance: (item, transition) =>
      Effect.flatMap(Ref.modify(store, advancing(item, transition)), Effect.fromResult),
  }),
);
