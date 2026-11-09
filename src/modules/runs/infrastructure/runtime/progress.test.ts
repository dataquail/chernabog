import { isSetupError, Phase, PhaseMoved, PhaseWriter, ProgressUnwritable } from "@chernabog/core";
import { describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { effect } from "../../../../../test/effect-test.ts";
import { makeThreadsFake } from "../../../../../test/github-threads-fake.ts";
import { progressContract } from "../../../../../test/progress-contract.ts";
import { githubTestLayer } from "../../../../platform/github-api.ts";
import {
  decide,
  isThreadItem,
  makeThreadsProgress,
  parseRecord,
  recordMessage,
  THREADS,
} from "./progress.ts";

const SLUG = "acme/app";

const adapterOver = (fake: ReturnType<typeof makeThreadsFake>) =>
  makeThreadsProgress({ slug: SLUG, persona: Option.some("data-quail") }).pipe(
    Effect.provide(githubTestLayer(fake.handler)),
  );

progressContract(
  "protected branches",
  Effect.suspend(() => adapterOver(makeThreadsFake(SLUG))),
);

const phase = Schema.decodeSync(Phase);
const writer = Schema.decodeSync(PhaseWriter);

const ASKED = phase("review-asked");
const CHANGES = phase("changes-asked");
const RUN_A = writer("0eee9982-bb65-4a62-b603-25023ad948cb");
const RUN_B = writer("data-quail");

const isPhaseMoved = Schema.is(PhaseMoved);
const isProgressUnwritable = Schema.is(ProgressUnwritable);

const movedTo = <A, E>(exit: Exit.Exit<A, E>) =>
  Option.map(Option.filter(Exit.findErrorOption(exit), isPhaseMoved), (error) => error.found);

const defectOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.match(exit, {
    onSuccess: () => Option.none<unknown>(),
    onFailure: (cause) => Option.fromUndefinedOr(cause.reasons.find(Cause.isDieReason)?.defect),
  });

describe("a thread's commit message", () => {
  test("carries the record in trailers, the first phase without From", () => {
    expect(recordMessage("pr-73", { from: Option.none(), to: ASKED, by: RUN_A })).toEqual({
      headline: "chernabog: pr-73 review-asked",
      body: `Phase: review-asked\nBy: ${RUN_A}`,
    });

    expect(recordMessage("pr-73", { from: Option.some(ASKED), to: CHANGES, by: RUN_B })).toEqual({
      headline: "chernabog: pr-73 review-asked -> changes-asked",
      body: "Phase: changes-asked\nFrom: review-asked\nBy: data-quail",
    });
  });

  test("reads back as the record it was written from, with its commit as the version", () => {
    const message = recordMessage("pr-73", { from: Option.some(ASKED), to: CHANGES, by: RUN_B });

    expect(parseRecord("abc123", `${message.headline}\n\n${message.body}\n`)).toEqual(
      Option.some({ phase: CHANGES, from: Option.some(ASKED), by: RUN_B, version: "abc123" }),
    );
  });

  test("a commit with no record, or a malformed one, holds none", () => {
    expect(
      [
        "root",
        "Phase: Not A Phase\nBy: x",
        "Phase: review-asked",
        "Phase: a\nFrom: B C\nBy: x",
      ].map((message) => Option.isSome(parseRecord("abc", message))),
    ).toEqual([false, false, false, false]);
  });
});

describe("an item's thread", () => {
  test("is one branch below the threads, so its name holds no slash", () => {
    expect(["pr-73", "issue-12", "epic-40", "a.b_c"].map((item) => isThreadItem(item))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(
      ["", "pr/73", "-x", "a..b", "x.lock", "two words", "a".repeat(201)].map((item) =>
        isThreadItem(item),
      ),
    ).toEqual([false, false, false, false, false, false, false]);
  });

  effect("a name with a slash is a ProgressError, not a branch it would miss", () =>
    Effect.gen(function* () {
      const progress = yield* adapterOver(makeThreadsFake(SLUG));

      const exit = yield* Effect.exit(progress.read("feature/x"));

      expect(Option.map(Exit.findErrorOption(exit), (error) => error._tag)).toEqual(
        Option.some("ProgressError"),
      );
    }),
  );
});

describe("decide", () => {
  const record = { phase: ASKED, from: Option.none<Phase>(), by: RUN_A, version: "v1" };

  test("its own write, retried, is that record", () => {
    expect(
      decide("pr-73", Option.some(record), { from: Option.none(), to: ASKED, by: RUN_A }),
    ).toEqual(Result.succeed(Option.some(record)));
  });

  test("from the phase the item holds, it writes", () => {
    expect(
      decide("pr-73", Option.some(record), { from: Option.some(ASKED), to: CHANGES, by: RUN_B }),
    ).toEqual(Result.succeed(Option.none()));
    expect(decide("pr-73", Option.none(), { from: Option.none(), to: ASKED, by: RUN_A })).toEqual(
      Result.succeed(Option.none()),
    );
  });

  test("the same move by another writer is a lost race", () => {
    expect(
      Result.isFailure(
        decide("pr-73", Option.some(record), { from: Option.none(), to: ASKED, by: RUN_B }),
      ),
    ).toBe(true);
  });
});

describe("the protected-branch adapter on GitHub", () => {
  effect("starts a thread from a root commit with the empty tree, then creates its ref", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      const progress = yield* adapterOver(fake);

      const record = yield* progress.advance("pr-73", {
        from: Option.none(),
        to: ASKED,
        by: RUN_A,
      });

      expect(fake.refs.get(`refs/heads/${THREADS}pr-73`)).toBe(record.version);
      expect(fake.state.requests.filter((request) => request.startsWith("POST"))).toEqual([
        `POST /repos/${SLUG}/git/commits`,
        `POST /repos/${SLUG}/git/refs`,
      ]);
    }),
  );

  for (const answered of ["STALE_DATA", "FORBIDDEN"] as const) {
    effect(`maps a lost race answered as ${answered}, with HTTP 200, to PhaseMoved`, () =>
      Effect.gen(function* () {
        const fake = makeThreadsFake(SLUG);
        const progress = yield* adapterOver(fake);
        yield* progress.advance("pr-73", { from: Option.none(), to: ASKED, by: RUN_A });
        fake.state.lostRaceAs = answered;

        // Another writer moves the thread on between this one's read and its write.
        fake.state.beforeNextAdvance = Option.some(() => {
          fake.advanceAs(
            `${THREADS}pr-73`,
            "chernabog: pr-73 review-asked -> approved\n\nPhase: approved\nFrom: review-asked\nBy: someone",
          );
        });

        const exit = yield* Effect.exit(
          progress.advance("pr-73", { from: Option.some(ASKED), to: CHANGES, by: RUN_B }),
        );

        expect(movedTo(exit)).toEqual(Option.some(Option.some(phase("approved"))));
      }),
    );
  }

  effect("an advance the rulesets refuse is a setup error that says what to fix", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      const progress = yield* adapterOver(fake);
      yield* progress.advance("pr-73", { from: Option.none(), to: ASKED, by: RUN_A });
      fake.state.refuse = true;

      const exit = yield* Effect.exit(
        progress.advance("pr-73", { from: Option.some(ASKED), to: CHANGES, by: RUN_B }),
      );

      const unwritable = Option.filter(defectOf(exit), isProgressUnwritable);
      expect(Option.map(unwritable, isSetupError)).toEqual(Option.some(true));
      expect(Option.map(unwritable, (error) => error.message)).toEqual(
        Option.some(expect.stringContaining("data-quail can't record progress")),
      );
    }),
  );

  effect("a first phase the rulesets refuse is a setup error too", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      fake.state.refuse = true;
      const progress = yield* adapterOver(fake);

      const exit = yield* Effect.exit(
        progress.advance("pr-73", { from: Option.none(), to: ASKED, by: RUN_A }),
      );

      expect(Option.map(defectOf(exit), isSetupError)).toEqual(Option.some(true));
    }),
  );

  effect("a branch under the threads that holds no record is a ProgressError", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      fake.advanceAs(`${THREADS}pr-73`, "someone's own commit");
      const progress = yield* adapterOver(fake);

      const exit = yield* Effect.exit(progress.read("pr-73"));

      expect(Option.map(Exit.findErrorOption(exit), (error) => error._tag)).toEqual(
        Option.some("ProgressError"),
      );
    }),
  );
});
