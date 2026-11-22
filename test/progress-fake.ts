// An in-memory adapter of core's Progress port, for tests: each item's
// record in a map, an advance a compare-and-set on it. It passes the contract
// every adapter must (test/progress-contract.ts).

import { createHash } from "node:crypto";

import {
  blobBytes,
  type BlobHash,
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

// Each item's record, the bytes of each blob a record wrote, by the record's
// version and the blob's hash, and how many records have been written.
type Store = {
  readonly records: ReadonlyMap<string, PhaseRecord>;
  readonly blobs: ReadonlyMap<string, ReadonlyMap<BlobHash, Uint8Array>>;
  readonly written: number;
};

// A transition's blobs by their names, each once, in the order it gave them.
const named = (blobs: ReadonlyArray<Uint8Array | string>): ReadonlyMap<BlobHash, Uint8Array> =>
  new Map(
    blobs.map((blob) => {
      const bytes = blobBytes(blob);

      return [createHash("sha256").update(bytes).digest("hex"), Uint8Array.from(bytes)];
    }),
  );

const phaseOf = (record: Option.Option<PhaseRecord>): Option.Option<Phase> =>
  Option.map(record, (found) => found.phase);

// The phase the writer read, which the record it writes names as `from`.
const fromPhase = (transition: PhaseTransition) =>
  Option.map(transition.from, (read) => read.phase);

const versionOf = (read: Option.Option<{ readonly version: string }>) =>
  Option.map(read, (found) => found.version);

// The record is this transition, by this writer: a retry of a write that
// landed. A writer that read this very record isn't retrying it.
const isOwn = (record: PhaseRecord, transition: PhaseTransition) =>
  record.by === transition.by &&
  record.phase === transition.to &&
  Equal.equals(record.from, fromPhase(transition)) &&
  !Option.exists(transition.from, (read) => read.version === record.version);

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

    // A compare-and-set on the version the writer read.
    if (!Equal.equals(versionOf(current), versionOf(transition.from))) {
      return [
        Result.fail(
          new PhaseMoved({ item, expected: fromPhase(transition), found: phaseOf(current) }),
        ),
        store,
      ];
    }

    const written = store.written + 1;
    const blobs = named(transition.blobs ?? []);

    const record: PhaseRecord = {
      phase: transition.to,
      from: fromPhase(transition),
      by: transition.by,
      version: `v${written}`,
      at,
      data: Option.fromUndefinedOr(transition.data),
      blobs: [...blobs.keys()],
    };

    return [
      Result.succeed(record),
      {
        records: new Map([...store.records, [item, record]]),
        blobs: new Map([...store.blobs, [record.version, blobs]]),
        written,
      },
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
  let store: Store = { records: new Map(), blobs: new Map(), written: 0 };

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
    // Only a blob the item's record names, read at that record's version.
    blob: (item, hash) =>
      Effect.sync(() =>
        Option.flatMap(
          Option.filter(Option.fromUndefinedOr(store.records.get(item)), (record) =>
            record.blobs.includes(hash),
          ),
          (record) =>
            Option.map(
              Option.fromUndefinedOr(store.blobs.get(record.version)?.get(hash)),
              (bytes) => Uint8Array.from(bytes),
            ),
        ),
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
    // epoch unless the test says when, which a TestClock also starts at, with
    // the blobs it gives.
    seed: (
      item: string,
      phase: Phase,
      by: PhaseWriter,
      when: {
        readonly at?: DateTime.Utc;
        readonly data?: PhaseData;
        readonly blobs?: ReadonlyArray<Uint8Array | string>;
      } = {},
    ) => {
      const written = store.written + 1;
      const blobs = named(when.blobs ?? []);

      const record: PhaseRecord = {
        phase,
        from: phaseOf(Option.fromUndefinedOr(store.records.get(item))),
        by,
        version: `v${written}`,
        at: when.at ?? DateTime.makeUnsafe(0),
        data: Option.fromUndefinedOr(when.data),
        blobs: [...blobs.keys()],
      };

      store = {
        records: new Map([...store.records, [item, record]]),
        blobs: new Map([...store.blobs, [record.version, blobs]]),
        written,
      };
    },
  };
};

// A fresh fake, holding no records, each time it runs.
export const progressFake: Effect.Effect<Progress["Service"]> = Effect.sync(
  () => progressStore({ checked: false }).service,
);
