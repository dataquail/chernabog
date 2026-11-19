// An in-memory adapter of core's Progress port, for tests: each item's
// record in a map, an advance a compare-and-set on it. It passes the contract
// every adapter must (test/progress-contract.ts).

import {
  type Phase,
  type PhaseData,
  PhaseMoved,
  type PhaseRecord,
  type PhaseTransition,
  type PhaseWriter,
  type Progress,
} from "@chernabog/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

type Store = { readonly records: ReadonlyMap<string, PhaseRecord>; readonly written: number };

const phaseOf = (record: Option.Option<PhaseRecord>): Option.Option<Phase> =>
  Option.map(record, (found) => found.phase);

// The record is this transition, by this writer: a retry of a write that landed.
const isOwn = (record: PhaseRecord, transition: PhaseTransition) =>
  record.by === transition.by &&
  record.phase === transition.to &&
  Equal.equals(record.from, transition.from);

// What advancing `item` by `transition` does to `store`, all in one step, `at`
// the time it would be written.
const advancing =
  (item: string, transition: PhaseTransition, at: DateTime.Utc) =>
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
      at,
      data: Option.fromUndefinedOr(transition.data),
    };

    return [
      Result.succeed(record),
      { records: new Map([...store.records, [item, record]]), written },
    ];
  };

// The writer a test's seeded records name: a run before the test's, as the
// daemon and `ci run` name one, so the ledger's check takes it for a run.
export const EARLIER_RUN = "00000000-0000-4000-8000-000000000001";

// Why the record `item` would hold after a transition is one the catalogue
// doesn't declare (ADR 21, decision 5), if it is: the SDK's check, which
// test/ledger-checked.preload.ts registers for every test. This file imports
// no SDK, since the binary's own tests use it (ADR 4).
type TransitionCheck = (item: string, record: PhaseRecord) => Option.Option<string>;

let undeclared: TransitionCheck = () => Option.none();

export const checkTransitionsWith = (check: TransitionCheck) => {
  undeclared = check;
};

// Every advance a test's flows make, checked against the catalogue: so the
// whole suite, every recipe and document it runs, shows the catalogue
// declares every transition they really make. A transition it doesn't
// declare fails the test, as a defect; `checked: false` for a test of the
// port itself, which records phases of no flow.
export type StoreOptions = { readonly checked?: boolean };

// A fake holding no records, and its store, which a test seeds and reads as
// it likes: every trigger and run given the service shares the one store.
export const progressStore = (options: StoreOptions = {}) => {
  let store: Store = { records: new Map(), written: 0 };

  const service: Progress["Service"] = {
    read: (item) => Effect.sync(() => Option.fromUndefinedOr(store.records.get(item))),
    readAll: Effect.sync(() => store.records),
    // Written at the Clock's time, so a test that moves a TestClock moves
    // when its records say they were written.
    advance: (item, transition) =>
      Effect.flatMap(DateTime.now, (at) =>
        Effect.suspend(() => {
          const [result, next] = advancing(item, transition, at)(store);

          if (Result.isSuccess(result) && options.checked !== false) {
            for (const why of Option.toArray(undeclared(item, result.success))) {
              return Effect.die(new Error(`an undeclared transition: ${why}`));
            }
          }

          store = next;

          return Effect.fromResult(result);
        }),
      ),
  };

  return {
    service,
    // Each item's whole record now, by item.
    records: (): ReadonlyMap<string, PhaseRecord> => store.records,
    // The phase each item holds now, by item.
    phases: (): Record<string, string> =>
      Object.fromEntries([...store.records].map(([item, record]) => [item, record.phase])),
    // Moves `item` to `phase` from whatever it holds, as a writer before the
    // test would have: a state for the test to start from. Written `at` the
    // epoch unless the test says when, which a TestClock also starts at.
    seed: (
      item: string,
      phase: Phase,
      by: PhaseWriter,
      when: { readonly at?: DateTime.Utc; readonly data?: PhaseData } = {},
    ) => {
      const written = store.written + 1;

      const record: PhaseRecord = {
        phase,
        from: phaseOf(Option.fromUndefinedOr(store.records.get(item))),
        by,
        version: `v${written}`,
        at: when.at ?? DateTime.makeUnsafe(0),
        data: Option.fromUndefinedOr(when.data),
      };

      store = { records: new Map([...store.records, [item, record]]), written };
    },
  };
};

// A fresh fake, holding no records, each time it runs.
export const progressFake: Effect.Effect<Progress["Service"]> = Effect.sync(
  () => progressStore({ checked: false }).service,
);
