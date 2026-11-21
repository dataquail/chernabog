import {
  isSetupError,
  Phase,
  PhaseData,
  PhaseMoved,
  PhaseWriter,
  ProgressUnwritable,
  UNREADABLE_PHASE,
  UNREADABLE_WRITER,
  unreadableWhy,
} from "@chernabog/core";
import { describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
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

const AT = DateTime.makeUnsafe("2026-11-17T12:00:00Z");

const DATA = Schema.decodeSync(PhaseData)({
  adopted: 81,
  url: "https://github.com/acme/app/pull/81",
});

// Strings a regex's `^` and `$` would break a line at, though git doesn't.
const SEPARATED = Schema.decodeSync(PhaseData)({ title: "a\u2028b", body: "c\u2029d" });

// The SHA-256 of "the plan", and of the bytes 0x00 0xff.
const PLAN_HASH = "aab8f06fecd1c041e9a3d5a86114f9e522b546918db8503a045fe4a423b3642a";
const BYTES_HASH = "06eb7d6a69ee19e5fbdf749018d3d2abfa04bcbd1365db312eb86dc7169389b8";

const isPhaseMoved = Schema.is(PhaseMoved);
const isProgressUnwritable = Schema.is(ProgressUnwritable);

const movedTo = <A, E>(exit: Exit.Exit<A, E>) =>
  Option.map(Option.filter(Exit.findErrorOption(exit), isPhaseMoved), (error) => error.found);

const defectOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.match(exit, {
    onSuccess: () => Option.none<unknown>(),
    onFailure: (cause) => Option.fromUndefinedOr(cause.reasons.find(Cause.isDieReason)?.defect),
  });

// What a writer read before moving the item on from review-asked.
const READ_ASKED = { phase: ASKED, version: "asked01" };

describe("a thread's commit message", () => {
  test("carries the record in trailers, the first phase without From", () => {
    expect(recordMessage("pr-73", { from: Option.none(), to: ASKED, by: RUN_A })).toEqual({
      headline: "chernabog: pr-73 review-asked",
      body: `Phase: review-asked\nBy: ${RUN_A}`,
    });

    expect(
      recordMessage("pr-73", { from: Option.some(READ_ASKED), to: CHANGES, by: RUN_B }),
    ).toEqual({
      headline: "chernabog: pr-73 review-asked -> changes-asked",
      body: "Phase: changes-asked\nFrom: review-asked\nBy: data-quail",
    });
  });

  test("carries data as one line of JSON in a Data trailer", () => {
    expect(
      recordMessage("issue-12", { from: Option.none(), to: ASKED, by: RUN_B, data: DATA }).body,
    ).toEqual(
      'Phase: review-asked\nBy: data-quail\nData: {"adopted":81,"url":"https://github.com/acme/app/pull/81"}',
    );
  });

  test("reads back as the record it was written from, with its commit as the version and time", () => {
    const message = recordMessage("pr-73", {
      from: Option.some(READ_ASKED),
      to: CHANGES,
      by: RUN_B,
    });

    expect(parseRecord("abc123", `${message.headline}\n\n${message.body}\n`, AT)).toEqual(
      Option.some({
        phase: CHANGES,
        from: Option.some(ASKED),
        by: RUN_B,
        version: "abc123",
        at: AT,
        data: Option.none(),
        blobs: [],
      }),
    );

    const carrying = recordMessage("issue-12", {
      from: Option.none(),
      to: ASKED,
      by: RUN_B,
      data: DATA,
    });

    expect(
      Option.map(
        parseRecord("def456", `${carrying.headline}\n\n${carrying.body}\n`, AT),
        (record) => record.data,
      ),
    ).toEqual(Option.some(Option.some(DATA)));
  });

  test("data holding U+2028 or U+2029 reads back as written, on one line", () => {
    const message = recordMessage("pr-73", {
      from: Option.none(),
      to: ASKED,
      by: RUN_B,
      data: SEPARATED,
    });

    expect(message.body).not.toMatch(/[\u2028\u2029]/);
    expect(
      Option.map(
        parseRecord("abc123", `${message.headline}\n\n${message.body}\n`, AT),
        (record) => record.data,
      ),
    ).toEqual(Option.some(Option.some(SEPARATED)));
    expect(
      Option.map(
        parseRecord("abc123", 'Phase: review-asked\nBy: x\nData: {"title":"a\u2028b"}', AT),
        (record) => record.data,
      ),
    ).toEqual(Option.some(Option.some(Schema.decodeSync(PhaseData)({ title: "a\u2028b" }))));
  });

  test("names the blobs it wrote by hash in a Blobs trailer, which reads back", () => {
    const message = recordMessage("pr-73", {
      from: Option.none(),
      to: ASKED,
      by: RUN_B,
      blobs: ["the plan", "the plan", new Uint8Array([0, 255])],
    });

    expect(message.body).toEqual(
      `Phase: review-asked\nBy: data-quail\nBlobs: ${PLAN_HASH} ${BYTES_HASH}`,
    );
    expect(
      Option.map(
        parseRecord("abc123", `${message.headline}\n\n${message.body}\n`, AT),
        (record) => record.blobs,
      ),
    ).toEqual(Option.some([PLAN_HASH, BYTES_HASH]));
  });

  test("a commit with no record, or a malformed one, holds none", () => {
    expect(
      [
        "root",
        "Phase: Not A Phase\nBy: x",
        "Phase: review-asked",
        "Phase: a\nFrom: B C\nBy: x",
        "Phase: a\nBy: x\nData: not json",
        "Phase: a\nBy: x\nData: [1, 2]",
        "Phase: a\nBy: x\nBlobs: not-a-hash",
        `Phase: a\nBy: x\nBlobs: ${PLAN_HASH.toUpperCase()}`,
      ].map((message) => Option.isSome(parseRecord("abc", message, AT))),
    ).toEqual([false, false, false, false, false, false, false, false]);
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

  effect("a later run reads data holding U+2028 or U+2029 back, and can advance the item", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);

      yield* Effect.flatMap(adapterOver(fake), (progress) =>
        progress.advance("pr-73", { from: Option.none(), to: ASKED, by: RUN_A, data: SEPARATED }),
      );

      // A fresh adapter has seen no commit, so it reads the record from the message.
      const later = yield* adapterOver(fake);

      const read = yield* later.read("pr-73");

      expect(Option.map(read, (record) => record.data)).toEqual(
        Option.some(Option.some(SEPARATED)),
      );
      expect((yield* later.readAll).get("pr-73")?.data).toEqual(Option.some(SEPARATED));
      expect((yield* later.advance("pr-73", { from: read, to: CHANGES, by: RUN_B })).phase).toEqual(
        CHANGES,
      );
    }),
  );

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
  const record = {
    phase: ASKED,
    from: Option.none<Phase>(),
    by: RUN_A,
    version: "v1",
    at: AT,
    data: Option.none(),
    blobs: [],
  };

  test("its own write, retried, is that record", () => {
    expect(
      decide("pr-73", Option.some(record), { from: Option.none(), to: ASKED, by: RUN_A }),
    ).toEqual(Result.succeed(Option.some(record)));
  });

  test("from the phase the item holds, it writes", () => {
    expect(
      decide("pr-73", Option.some(record), { from: Option.some(record), to: CHANGES, by: RUN_B }),
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

  effect("a first phase with blobs is a root commit whose tree holds each at blobs/<hash>", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      const progress = yield* adapterOver(fake);

      const record = yield* progress.advance("pr-73", {
        from: Option.none(),
        to: ASKED,
        by: RUN_A,
        blobs: ["the plan"],
      });

      expect(fake.filesOf(record.version)).toEqual(
        new Map([[`blobs/${PLAN_HASH}`, new TextEncoder().encode("the plan")]]),
      );
      expect(fake.state.requests.filter((request) => request.startsWith("POST"))).toEqual([
        `POST /repos/${SLUG}/git/blobs`,
        `POST /repos/${SLUG}/git/trees`,
        `POST /repos/${SLUG}/git/commits`,
        `POST /repos/${SLUG}/git/refs`,
      ]);
    }),
  );

  effect("a later phase adds its blobs in createCommitOnBranch, and reads one at its record", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      const progress = yield* adapterOver(fake);
      const asked = yield* progress.advance("pr-73", { from: Option.none(), to: ASKED, by: RUN_A });

      const changes = yield* progress.advance("pr-73", {
        from: Option.some(asked),
        to: CHANGES,
        by: RUN_B,
        blobs: [new Uint8Array([0, 255])],
      });

      expect(fake.filesOf(changes.version)).toEqual(
        new Map([[`blobs/${BYTES_HASH}`, new Uint8Array([0, 255])]]),
      );

      fake.state.requests.length = 0;

      expect(yield* progress.blob("pr-73", BYTES_HASH)).toEqual(
        Option.some(new Uint8Array([0, 255])),
      );
      expect(fake.state.requests).toContain(
        `graphql object ${changes.version}:blobs/${BYTES_HASH}`,
      );
    }),
  );

  effect("a lost race leaves no blob on the thread", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      const progress = yield* adapterOver(fake);
      const asked = yield* progress.advance("pr-73", { from: Option.none(), to: ASKED, by: RUN_A });

      fake.state.beforeNextAdvance = Option.some(() => {
        fake.advanceAs(
          `${THREADS}pr-73`,
          "chernabog: pr-73 review-asked -> approved\n\nPhase: approved\nFrom: review-asked\nBy: someone",
        );
      });

      const exit = yield* Effect.exit(
        progress.advance("pr-73", {
          from: Option.some(asked),
          to: CHANGES,
          by: RUN_B,
          blobs: ["the plan"],
        }),
      );

      expect(Option.isSome(movedTo(exit))).toBe(true);
      expect(fake.everyFile().has(`blobs/${PLAN_HASH}`)).toBe(false);
    }),
  );

  for (const answered of ["STALE_DATA", "FORBIDDEN"] as const) {
    effect(`maps a lost race answered as ${answered}, with HTTP 200, to PhaseMoved`, () =>
      Effect.gen(function* () {
        const fake = makeThreadsFake(SLUG);
        const progress = yield* adapterOver(fake);

        const asked = yield* progress.advance("pr-73", {
          from: Option.none(),
          to: ASKED,
          by: RUN_A,
        });

        fake.state.lostRaceAs = answered;

        // Another writer moves the thread on between this one's read and its write.
        fake.state.beforeNextAdvance = Option.some(() => {
          fake.advanceAs(
            `${THREADS}pr-73`,
            "chernabog: pr-73 review-asked -> approved\n\nPhase: approved\nFrom: review-asked\nBy: someone",
          );
        });

        const exit = yield* Effect.exit(
          progress.advance("pr-73", { from: Option.some(asked), to: CHANGES, by: RUN_B }),
        );

        expect(movedTo(exit)).toEqual(Option.some(Option.some(phase("approved"))));
      }),
    );
  }

  effect("an advance the rulesets refuse is a setup error that says what to fix", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      const progress = yield* adapterOver(fake);
      const asked = yield* progress.advance("pr-73", { from: Option.none(), to: ASKED, by: RUN_A });
      fake.state.refuse = true;

      const exit = yield* Effect.exit(
        progress.advance("pr-73", { from: Option.some(asked), to: CHANGES, by: RUN_B }),
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

  // One bad thread holds only its own item (#549): the record it reads as
  // names the commit and why it isn't one, for the ledger's check to hold
  // the item by, rather than failing every read of every item.
  effect("a branch under the threads that holds no record reads as an unreadable record", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      const oid = fake.advanceAs(`${THREADS}pr-73`, "someone's own commit");
      const progress = yield* adapterOver(fake);

      const read = yield* progress.read("pr-73");

      expect(Option.map(read, (record) => [record.phase, record.by, record.version])).toEqual(
        Option.some([UNREADABLE_PHASE, UNREADABLE_WRITER, oid]),
      );
      expect(Option.flatMap(read, unreadableWhy)).toEqual(Option.some("it has no Phase trailer"));
    }),
  );

  effect("a branch's commit that holds no record says why", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);

      const messages = [
        "root",
        "Phase: Not A Phase\nBy: x",
        "Phase: review-asked",
        "Phase: a\nBy: not a writer",
        "Phase: a\nFrom: B C\nBy: x",
        "Phase: a\nBy: x\nData: not json",
      ];

      messages.forEach((message, index) => fake.advanceAs(`${THREADS}item-${index}`, message));
      const progress = yield* adapterOver(fake);

      const whys = yield* Effect.forEach(messages, (_, index) =>
        Effect.map(progress.read(`item-${index}`), (read) => Option.flatMap(read, unreadableWhy)),
      );

      expect(whys).toEqual(
        [
          "it has no Phase trailer",
          "its Phase trailer isn't a phase",
          "it has no By trailer",
          "its By trailer isn't a writer",
          "its From trailer isn't a phase",
          "its Data trailer isn't a JSON object a record can hold",
        ].map(Option.some),
      );
    }),
  );

  effect("readAll reads every other item when one thread holds no record", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      const progress = yield* adapterOver(fake);

      yield* progress.advance("pr-72", { from: Option.none(), to: ASKED, by: RUN_A });
      yield* progress.advance("pr-74", { from: Option.none(), to: CHANGES, by: RUN_B });
      fake.advanceAs(
        `${THREADS}pr-73`,
        'chernabog: pr-73\n\nPhase: review-asked\nBy: x\nData: {"a"',
      );

      const all = yield* (yield* adapterOver(fake)).readAll;

      const items = Arr.sort([...all.keys()], Order.String);

      expect(items.map((item) => [item, all.get(item)?.phase])).toEqual([
        ["pr-72", ASKED],
        ["pr-73", phase(UNREADABLE_PHASE)],
        ["pr-74", CHANGES],
      ]);
      expect(Option.flatMap(Option.fromUndefinedOr(all.get("pr-73")), unreadableWhy)).toEqual(
        Option.some("its Data trailer isn't a JSON object a record can hold"),
      );
    }),
  );

  effect("an advance from no record loses the race to an unreadable record", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      fake.advanceAs(`${THREADS}pr-73`, "someone's own commit");
      const progress = yield* adapterOver(fake);

      const exit = yield* Effect.exit(
        progress.advance("pr-73", { from: Option.none(), to: ASKED, by: RUN_A }),
      );

      expect(movedTo(exit)).toEqual(Option.some(Option.some(phase(UNREADABLE_PHASE))));
    }),
  );
});
