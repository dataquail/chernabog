// What every adapter of core's Progress port must do (ADR 0019), as tests any
// adapter's own test file runs: `progressContract("the fake", makeProgressFake)`
// here, and the protected-branch adapter's against its storage (#364). The
// suite knows the port alone, so a hosted adapter runs it unchanged.

import { createHash } from "node:crypto";

import {
  blobBytes,
  Phase,
  PhaseData,
  PhaseMoved,
  type PhaseRead,
  type PhaseRecord,
  type PhaseTransition,
  PhaseWriter,
  type Progress,
} from "@chernabog/core";
import type { BunServices } from "@effect/platform-bun";
import { describe, expect } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { effect } from "./effect-test.ts";

// Makes a fresh adapter, holding no records, each time a test runs it, with
// Bun's platform services, which each test has.
export type MakeProgress<E> = Effect.Effect<
  Progress["Service"],
  E,
  Scope.Scope | BunServices.BunServices
>;

const phase = Schema.decodeSync(Phase);
const writer = Schema.decodeSync(PhaseWriter);

const REVIEW_ASKED = phase("review-asked");
const CHANGES_ASKED = phase("changes-asked");
const REVIEW_ASKED_AGAIN = phase("review-asked-again");

const RUN_A = writer("0eee9982-bb65-4a62-b603-25023ad948cb");
const RUN_B = writer("5c1d6e1a-3f2b-4a9e-8c7d-2b1e0f9a8d7c");

const ITEM = "pr-73";

const first = (to: Phase, by: PhaseWriter): PhaseTransition => ({ from: Option.none(), to, by });

// A move on from `from`, the record the writer read.
const after = (from: PhaseRead, to: Phase, by: PhaseWriter): PhaseTransition => ({
  from: Option.some(from),
  to,
  by,
});

// A record no adapter wrote: a writer that read a phase the item never held.
const neverHeld = (at: Phase): PhaseRead => ({ phase: at, version: "never-written" });

const DATA = Schema.decodeSync(PhaseData)({ adopted: 81, round: 2, nested: { draft: true } });

// Strings a regex's `^` and `$` would break a line at, though git doesn't.
const SEPARATED = Schema.decodeSync(PhaseData)({ title: "a\u2028b", body: "c\u2029d" });

const isPhaseMoved = Schema.is(PhaseMoved);

// The lost race an advance failed with, if it failed with one.
const moved = <A, E>(exit: Exit.Exit<A, E>) =>
  Option.filter(Exit.findErrorOption(exit), isPhaseMoved);

// A blob's name, as the port gives it: the SHA-256 of its bytes, in hex.
const hashOf = (blob: Uint8Array | string) =>
  createHash("sha256").update(blobBytes(blob)).digest("hex");

// Larger than a record's data may hold, as a plan is.
const PLAN = `# The plan\n\n${"- a step of the plan, \u2028 and all\n".repeat(400)}`;

// Bytes that aren't UTF-8.
const BYTES = new Uint8Array([0, 255, 1, 128, 10, 13, 0xfe]);

const what = (record: PhaseRecord) => ({ phase: record.phase, from: record.from, by: record.by });

export const progressContract = <E>(name: string, make: MakeProgress<E>) => {
  describe(`${name}: the Progress contract`, () => {
    effect("keeps the data a transition carries, alone and in readAll", () =>
      Effect.gen(function* () {
        const progress = yield* make;

        const written = yield* progress.advance(ITEM, {
          ...first(REVIEW_ASKED, RUN_A),
          data: DATA,
        });

        expect(written.data).toEqual(Option.some(DATA));
        expect(Option.map(yield* progress.read(ITEM), (record) => record.data)).toEqual(
          Option.some(Option.some(DATA)),
        );
        expect((yield* progress.readAll).get(ITEM)?.data).toEqual(Option.some(DATA));

        const next = yield* progress.advance(ITEM, after(written, CHANGES_ASKED, RUN_B));

        expect(next.data).toEqual(Option.none());
        expect(Option.map(yield* progress.read(ITEM), (record) => record.data)).toEqual(
          Option.some(Option.none()),
        );
      }),
    );

    effect("keeps data whose strings hold U+2028 or U+2029, and the item can still advance", () =>
      Effect.gen(function* () {
        const progress = yield* make;

        const asked = yield* progress.advance(ITEM, {
          ...first(REVIEW_ASKED, RUN_A),
          data: SEPARATED,
        });

        expect(Option.map(yield* progress.read(ITEM), (record) => record.data)).toEqual(
          Option.some(Option.some(SEPARATED)),
        );
        expect((yield* progress.readAll).get(ITEM)?.data).toEqual(Option.some(SEPARATED));

        const next = yield* progress.advance(ITEM, after(asked, CHANGES_ASKED, RUN_B));

        expect(next.phase).toEqual(CHANGES_ASKED);
      }),
    );

    effect("says when each record was written, a later one never before an earlier", () =>
      Effect.gen(function* () {
        const progress = yield* make;

        const asked = yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));
        const changes = yield* progress.advance(ITEM, after(asked, CHANGES_ASKED, RUN_B));

        expect(DateTime.isLessThanOrEqualTo(asked.at, changes.at)).toBe(true);
        expect(Option.map(yield* progress.read(ITEM), (record) => record.at)).toEqual(
          Option.some(changes.at),
        );
      }),
    );

    effect("a retry of a write that landed returns it with the data it carried", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        const transition = { ...first(REVIEW_ASKED, RUN_A), data: DATA };

        const written = yield* progress.advance(ITEM, transition);

        expect(yield* progress.advance(ITEM, transition)).toEqual(written);
      }),
    );

    effect("an item with no record reads as none, alone and in readAll", () =>
      Effect.gen(function* () {
        const progress = yield* make;

        expect(yield* progress.read(ITEM)).toEqual(Option.none());
        expect((yield* progress.readAll).size).toBe(0);
      }),
    );

    effect("records an item's first phase, naming its writer, and reads it back", () =>
      Effect.gen(function* () {
        const progress = yield* make;

        const written = yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));

        expect(what(written)).toEqual({ phase: REVIEW_ASKED, from: Option.none(), by: RUN_A });
        expect(yield* progress.read(ITEM)).toEqual(Option.some(written));
        expect((yield* progress.readAll).get(ITEM)).toEqual(written);
      }),
    );

    effect("advances from the phase the item is in, recording the transition", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        const asked = yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));

        const changes = yield* progress.advance(ITEM, after(asked, CHANGES_ASKED, RUN_B));

        expect(what(changes)).toEqual({
          phase: CHANGES_ASKED,
          from: Option.some(REVIEW_ASKED),
          by: RUN_B,
        });
        expect(changes.version).not.toBe(asked.version);
        expect(yield* progress.read(ITEM)).toEqual(Option.some(changes));
      }),
    );

    effect("a phase can come round again, as a new record", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        const changes = yield* progress.advance(ITEM, first(CHANGES_ASKED, RUN_A));
        const once = yield* progress.advance(ITEM, after(changes, REVIEW_ASKED_AGAIN, RUN_A));
        const again = yield* progress.advance(ITEM, after(once, CHANGES_ASKED, RUN_B));
        const twice = yield* progress.advance(ITEM, after(again, REVIEW_ASKED_AGAIN, RUN_A));

        expect(twice.phase).toBe(REVIEW_ASKED_AGAIN);
        expect(twice.version).not.toBe(once.version);
      }),
    );

    effect("refuses to advance from a phase the item has left, and writes nothing", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        const asked = yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));
        const changes = yield* progress.advance(ITEM, after(asked, CHANGES_ASKED, RUN_A));

        const exit = yield* Effect.exit(
          progress.advance(ITEM, after(asked, REVIEW_ASKED_AGAIN, RUN_B)),
        );

        expect(Option.map(moved(exit), (error) => [error.expected, error.found])).toEqual(
          Option.some([Option.some(REVIEW_ASKED), Option.some(CHANGES_ASKED)]),
        );
        expect(yield* progress.read(ITEM)).toEqual(Option.some(changes));
      }),
    );

    // The compare-and-set is on the version the writer read, not its phase:
    // a record that moved on and came back to the same phase is a new one.
    effect("refuses an advance from a record the item has since left and come back to", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        const asked = yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));
        const changes = yield* progress.advance(ITEM, after(asked, CHANGES_ASKED, RUN_A));
        const back = yield* progress.advance(ITEM, after(changes, REVIEW_ASKED, RUN_A));

        expect(back.phase).toBe(asked.phase);

        const exit = yield* Effect.exit(progress.advance(ITEM, after(asked, CHANGES_ASKED, RUN_B)));

        expect(Option.map(moved(exit), (error) => error.found)).toEqual(
          Option.some(Option.some(REVIEW_ASKED)),
        );
        expect(yield* progress.read(ITEM)).toEqual(Option.some(back));
      }),
    );

    effect("refuses a first phase for an item that already has one", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));

        const exit = yield* Effect.exit(progress.advance(ITEM, first(CHANGES_ASKED, RUN_B)));

        expect(Option.map(moved(exit), (error) => [error.expected, error.found])).toEqual(
          Option.some([Option.none(), Option.some(REVIEW_ASKED)]),
        );
      }),
    );

    effect("refuses an advance from a phase on an item with no record", () =>
      Effect.gen(function* () {
        const progress = yield* make;

        const exit = yield* Effect.exit(
          progress.advance(ITEM, after(neverHeld(REVIEW_ASKED), CHANGES_ASKED, RUN_A)),
        );

        expect(Option.map(moved(exit), (error) => [error.expected, error.found])).toEqual(
          Option.some([Option.some(REVIEW_ASKED), Option.none()]),
        );
        expect(yield* progress.read(ITEM)).toEqual(Option.none());
      }),
    );

    // A run can crash after its advance lands and before it journals that it
    // did. Resumed, it advances again: finding its own transition is success.
    effect("a retried advance finds its own transition and succeeds, writing nothing", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        const asked = yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));
        const landed = yield* progress.advance(ITEM, after(asked, CHANGES_ASKED, RUN_B));

        const retried = yield* progress.advance(ITEM, after(asked, CHANGES_ASKED, RUN_B));

        expect(retried).toEqual(landed);
        expect(yield* progress.read(ITEM)).toEqual(Option.some(landed));
      }),
    );

    // A wait recorded again over this writer's own record of it, as a plan's
    // wait over the plan its run proposed, is a new move: the writer read it.
    effect("the same move again, from the record it read, writes a new record", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        const asked = yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));
        const again = yield* progress.advance(ITEM, after(asked, REVIEW_ASKED, RUN_A));

        const thrice = yield* progress.advance(ITEM, {
          ...after(again, REVIEW_ASKED, RUN_A),
          data: DATA,
          blobs: [PLAN],
        });

        expect(thrice.version).not.toBe(again.version);
        expect(thrice.data).toEqual(Option.some(DATA));
        expect(yield* progress.read(ITEM)).toEqual(Option.some(thrice));
        expect(yield* progress.blob(ITEM, hashOf(PLAN))).toEqual(Option.some(blobBytes(PLAN)));
      }),
    );

    effect("a retried first phase finds its own record and succeeds", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        const landed = yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));

        expect(yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A))).toEqual(landed);
      }),
    );

    // Another writer's record isn't this writer's, even when it made the same move.
    effect("the same transition by another writer is a lost race", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        const asked = yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));
        yield* progress.advance(ITEM, after(asked, CHANGES_ASKED, RUN_A));

        const exit = yield* Effect.exit(progress.advance(ITEM, after(asked, CHANGES_ASKED, RUN_B)));

        expect(Option.map(moved(exit), (error) => error.found)).toEqual(
          Option.some(Option.some(CHANGES_ASKED)),
        );
      }),
    );

    // A writer's own record is the move it made: from the same read to another
    // phase is a second move, which the item has already left behind.
    effect(
      "the same writer moving on again from the same read, to another phase, is a lost race",
      () =>
        Effect.gen(function* () {
          const progress = yield* make;
          const asked = yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));
          const changes = yield* progress.advance(ITEM, after(asked, CHANGES_ASKED, RUN_A));

          const exit = yield* Effect.exit(
            progress.advance(ITEM, after(asked, REVIEW_ASKED_AGAIN, RUN_A)),
          );

          expect(Option.map(moved(exit), (error) => [error.expected, error.found])).toEqual(
            Option.some([Option.some(REVIEW_ASKED), Option.some(CHANGES_ASKED)]),
          );
          expect(yield* progress.read(ITEM)).toEqual(Option.some(changes));
        }),
    );

    effect("the same writer's second first phase, to another phase, is a lost race", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        const asked = yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));

        const exit = yield* Effect.exit(progress.advance(ITEM, first(CHANGES_ASKED, RUN_A)));

        expect(Option.map(moved(exit), (error) => [error.expected, error.found])).toEqual(
          Option.some([Option.none(), Option.some(REVIEW_ASKED)]),
        );
        expect(yield* progress.read(ITEM)).toEqual(Option.some(asked));
      }),
    );

    // Only the record the item holds now counts: once another writer has moved
    // it on, a retry fails as the item has moved, which it has.
    effect("a retry after another writer moved the item on is a lost race", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        const asked = yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));
        const changes = yield* progress.advance(ITEM, after(asked, CHANGES_ASKED, RUN_A));
        const later = yield* progress.advance(ITEM, after(changes, REVIEW_ASKED_AGAIN, RUN_B));

        const exit = yield* Effect.exit(progress.advance(ITEM, after(asked, CHANGES_ASKED, RUN_A)));

        expect(Option.isSome(moved(exit))).toBe(true);
        expect(yield* progress.read(ITEM)).toEqual(Option.some(later));
      }),
    );

    effect("of two advances from the same phase at once, exactly one wins", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        const asked = yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));

        const exits = yield* Effect.all(
          [
            Effect.exit(progress.advance(ITEM, after(asked, CHANGES_ASKED, RUN_A))),
            Effect.exit(progress.advance(ITEM, after(asked, REVIEW_ASKED_AGAIN, RUN_B))),
          ],
          { concurrency: "unbounded" },
        );

        const won = exits.filter(Exit.isSuccess);
        expect(won.length).toBe(1);
        expect(exits.filter((exit) => Option.isSome(moved(exit))).length).toBe(1);
        expect(yield* progress.read(ITEM)).toEqual(Option.some(won[0]?.value));
      }),
    );

    effect("of two first phases at once, exactly one wins", () =>
      Effect.gen(function* () {
        const progress = yield* make;

        const exits = yield* Effect.all(
          [
            Effect.exit(progress.advance(ITEM, first(REVIEW_ASKED, RUN_A))),
            Effect.exit(progress.advance(ITEM, first(CHANGES_ASKED, RUN_B))),
          ],
          { concurrency: "unbounded" },
        );

        expect(exits.filter(Exit.isSuccess).length).toBe(1);
        expect(exits.filter((exit) => Option.isSome(moved(exit))).length).toBe(1);
      }),
    );

    effect("writes blobs with the record, names each by its SHA-256, and reads each back", () =>
      Effect.gen(function* () {
        const progress = yield* make;

        const written = yield* progress.advance(ITEM, {
          ...first(REVIEW_ASKED, RUN_A),
          blobs: [PLAN, BYTES],
        });

        expect(written.blobs).toEqual([hashOf(PLAN), hashOf(BYTES)]);
        expect(Option.map(yield* progress.read(ITEM), (record) => record.blobs)).toEqual(
          Option.some([hashOf(PLAN), hashOf(BYTES)]),
        );
        expect((yield* progress.readAll).get(ITEM)?.blobs).toEqual([hashOf(PLAN), hashOf(BYTES)]);
        expect(yield* progress.blob(ITEM, hashOf(PLAN))).toEqual(Option.some(blobBytes(PLAN)));
        expect(yield* progress.blob(ITEM, hashOf(BYTES))).toEqual(Option.some(BYTES));
      }),
    );

    effect("a later record writes blobs too, and a record with none names none", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        const asked = yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));

        expect(asked.blobs).toEqual([]);

        const changes = yield* progress.advance(ITEM, {
          ...after(asked, CHANGES_ASKED, RUN_B),
          blobs: [PLAN, PLAN],
        });

        expect(changes.blobs).toEqual([hashOf(PLAN)]);
        expect(yield* progress.blob(ITEM, hashOf(PLAN))).toEqual(Option.some(blobBytes(PLAN)));
      }),
    );

    effect("a retry of a write that landed with blobs returns it, blobs and all", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        const asked = yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));
        const transition = { ...after(asked, CHANGES_ASKED, RUN_B), blobs: [PLAN] };

        const written = yield* progress.advance(ITEM, transition);

        expect(yield* progress.advance(ITEM, transition)).toEqual(written);
        expect(yield* progress.blob(ITEM, hashOf(PLAN))).toEqual(Option.some(blobBytes(PLAN)));
      }),
    );

    effect("a lost race writes no blob", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        const asked = yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));
        const changes = yield* progress.advance(ITEM, after(asked, CHANGES_ASKED, RUN_A));

        const exit = yield* Effect.exit(
          progress.advance(ITEM, { ...after(asked, REVIEW_ASKED_AGAIN, RUN_B), blobs: [PLAN] }),
        );

        expect(Option.isSome(moved(exit))).toBe(true);
        expect(yield* progress.read(ITEM)).toEqual(Option.some(changes));
        expect(yield* progress.blob(ITEM, hashOf(PLAN))).toEqual(Option.none());
      }),
    );

    effect("a lost first phase writes no blob", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));

        const exit = yield* Effect.exit(
          progress.advance(ITEM, { ...first(CHANGES_ASKED, RUN_B), blobs: [PLAN] }),
        );

        expect(Option.isSome(moved(exit))).toBe(true);
        expect(yield* progress.blob(ITEM, hashOf(PLAN))).toEqual(Option.none());
      }),
    );

    effect("reads no blob the item's record doesn't name", () =>
      Effect.gen(function* () {
        const progress = yield* make;

        expect(yield* progress.blob(ITEM, hashOf(PLAN))).toEqual(Option.none());

        const asked = yield* progress.advance(ITEM, {
          ...first(REVIEW_ASKED, RUN_A),
          blobs: [PLAN],
        });

        expect(yield* progress.blob(ITEM, hashOf(BYTES))).toEqual(Option.none());
        expect(yield* progress.blob("pr-7", hashOf(PLAN))).toEqual(Option.none());

        // An earlier record's blob, which the item's record now doesn't name.
        yield* progress.advance(ITEM, after(asked, CHANGES_ASKED, RUN_B));

        expect(yield* progress.blob(ITEM, hashOf(PLAN))).toEqual(Option.none());
      }),
    );

    effect("keeps each item's record apart, and readAll gives every one", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        const pull = yield* progress.advance("pr-73", first(REVIEW_ASKED, RUN_A));
        const issue = yield* progress.advance("issue-12", first(phase("handed-off"), RUN_A));
        const epic = yield* progress.advance("epic-40", first(phase("waiting"), RUN_B));

        const all = yield* progress.readAll;

        expect(all).toEqual(
          new Map([
            ["epic-40", epic],
            ["issue-12", issue],
            ["pr-73", pull],
          ]),
        );
        expect(yield* progress.read("pr-7")).toEqual(Option.none());
      }),
    );
  });
};
