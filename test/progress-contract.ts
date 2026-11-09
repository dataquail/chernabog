// What every adapter of core's Progress port must do (ADR 0019), as tests any
// adapter's own test file runs: `progressContract("the fake", makeProgressFake)`
// here, and the protected-branch adapter's against its storage (#364). The
// suite knows the port alone, so a hosted adapter runs it unchanged.

import {
  Phase,
  PhaseMoved,
  type PhaseRecord,
  type PhaseTransition,
  PhaseWriter,
  type Progress,
} from "@chernabog/core";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { effect } from "./effect-test.ts";

// Makes a fresh adapter, holding no records, each time a test runs it.
export type MakeProgress<E> = Effect.Effect<Progress["Service"], E, Scope.Scope>;

const phase = Schema.decodeSync(Phase);
const writer = Schema.decodeSync(PhaseWriter);

const REVIEW_ASKED = phase("review-asked");
const CHANGES_ASKED = phase("changes-asked");
const REVIEW_ASKED_AGAIN = phase("review-asked-again");

const RUN_A = writer("0eee9982-bb65-4a62-b603-25023ad948cb");
const RUN_B = writer("5c1d6e1a-3f2b-4a9e-8c7d-2b1e0f9a8d7c");

const ITEM = "pr-73";

const first = (to: Phase, by: PhaseWriter): PhaseTransition => ({ from: Option.none(), to, by });

const after = (from: Phase, to: Phase, by: PhaseWriter): PhaseTransition => ({
  from: Option.some(from),
  to,
  by,
});

const isPhaseMoved = Schema.is(PhaseMoved);

// The lost race an advance failed with, if it failed with one.
const moved = <A, E>(exit: Exit.Exit<A, E>) =>
  Option.filter(Exit.findErrorOption(exit), isPhaseMoved);

const what = (record: PhaseRecord) => ({ phase: record.phase, from: record.from, by: record.by });

export const progressContract = <E>(name: string, make: MakeProgress<E>) => {
  describe(`${name}: the Progress contract`, () => {
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

        const changes = yield* progress.advance(ITEM, after(REVIEW_ASKED, CHANGES_ASKED, RUN_B));

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
        yield* progress.advance(ITEM, first(CHANGES_ASKED, RUN_A));
        const once = yield* progress.advance(ITEM, after(CHANGES_ASKED, REVIEW_ASKED_AGAIN, RUN_A));
        yield* progress.advance(ITEM, after(REVIEW_ASKED_AGAIN, CHANGES_ASKED, RUN_B));

        const twice = yield* progress.advance(
          ITEM,
          after(CHANGES_ASKED, REVIEW_ASKED_AGAIN, RUN_A),
        );

        expect(twice.phase).toBe(REVIEW_ASKED_AGAIN);
        expect(twice.version).not.toBe(once.version);
      }),
    );

    effect("refuses to advance from a phase the item has left, and writes nothing", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));
        const changes = yield* progress.advance(ITEM, after(REVIEW_ASKED, CHANGES_ASKED, RUN_A));

        const exit = yield* Effect.exit(
          progress.advance(ITEM, after(REVIEW_ASKED, REVIEW_ASKED_AGAIN, RUN_B)),
        );

        expect(Option.map(moved(exit), (error) => [error.expected, error.found])).toEqual(
          Option.some([Option.some(REVIEW_ASKED), Option.some(CHANGES_ASKED)]),
        );
        expect(yield* progress.read(ITEM)).toEqual(Option.some(changes));
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
          progress.advance(ITEM, after(REVIEW_ASKED, CHANGES_ASKED, RUN_A)),
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
        yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));
        const landed = yield* progress.advance(ITEM, after(REVIEW_ASKED, CHANGES_ASKED, RUN_B));

        const retried = yield* progress.advance(ITEM, after(REVIEW_ASKED, CHANGES_ASKED, RUN_B));

        expect(retried).toEqual(landed);
        expect(yield* progress.read(ITEM)).toEqual(Option.some(landed));
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
        yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));
        yield* progress.advance(ITEM, after(REVIEW_ASKED, CHANGES_ASKED, RUN_A));

        const exit = yield* Effect.exit(
          progress.advance(ITEM, after(REVIEW_ASKED, CHANGES_ASKED, RUN_B)),
        );

        expect(Option.map(moved(exit), (error) => error.found)).toEqual(
          Option.some(Option.some(CHANGES_ASKED)),
        );
      }),
    );

    // Only the record the item holds now counts: once another writer has moved
    // it on, a retry fails as the item has moved, which it has.
    effect("a retry after another writer moved the item on is a lost race", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));
        yield* progress.advance(ITEM, after(REVIEW_ASKED, CHANGES_ASKED, RUN_A));

        const later = yield* progress.advance(
          ITEM,
          after(CHANGES_ASKED, REVIEW_ASKED_AGAIN, RUN_B),
        );

        const exit = yield* Effect.exit(
          progress.advance(ITEM, after(REVIEW_ASKED, CHANGES_ASKED, RUN_A)),
        );

        expect(Option.isSome(moved(exit))).toBe(true);
        expect(yield* progress.read(ITEM)).toEqual(Option.some(later));
      }),
    );

    effect("of two advances from the same phase at once, exactly one wins", () =>
      Effect.gen(function* () {
        const progress = yield* make;
        yield* progress.advance(ITEM, first(REVIEW_ASKED, RUN_A));

        const exits = yield* Effect.all(
          [
            Effect.exit(progress.advance(ITEM, after(REVIEW_ASKED, CHANGES_ASKED, RUN_A))),
            Effect.exit(progress.advance(ITEM, after(REVIEW_ASKED, REVIEW_ASKED_AGAIN, RUN_B))),
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
