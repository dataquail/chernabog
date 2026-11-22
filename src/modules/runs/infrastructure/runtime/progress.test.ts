import {
  isSetupError,
  type Json,
  Phase,
  PhaseData,
  PhaseMoved,
  PhaseWriter,
  printJson,
  type Progress,
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
import { type Answer, makeThreadsFake, NULL } from "../../../../../test/github-threads-fake.ts";
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

// A record's phase and writer.
const what = (record: { readonly phase: Phase; readonly by: PhaseWriter }) => [
  record.phase,
  record.by,
];

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

  test("a trailer is the first line of its key that has a value, without the space around it", () => {
    expect(
      Option.map(parseRecord("abc", "Phase: \nPhase: review-asked\nBy: data-quail", AT), what),
    ).toEqual(Option.some([ASKED, RUN_B]));
    expect(
      Option.map(parseRecord("abc", "Phase: review-asked \r\nBy: data-quail\r\n", AT), what),
    ).toEqual(Option.some([ASKED, RUN_B]));
  });

  test("a Blobs trailer's hashes may be set apart by more than one space", () => {
    expect(
      Option.map(
        parseRecord("abc", `Phase: a\nBy: x\nBlobs:  ${PLAN_HASH}   ${BYTES_HASH} `, AT),
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
        "Phase: a\nBy: x\nBlobs: not-a-hash",
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
          "its Blobs trailer isn't blob hashes",
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

// The error an advance or a read failed with, by its tag: none for a success
// or a defect.
const failedWith = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
  Option.map(Exit.findErrorOption(exit), (error) => error._tag);

// Whether an exit is the setup error a refusal is.
const refused = <A, E>(exit: Exit.Exit<A, E>) => Option.map(defectOf(exit), isSetupError);

// A record's message, as a hand-made commit or another writer's would hold it.
const messageOf = (item: string, from: Option.Option<Phase>, to: Phase, by: PhaseWriter) => {
  const message = recordMessage(item, {
    from: Option.map(from, (at) => ({ phase: at, version: "unread" })),
    to,
    by,
  });

  return `${message.headline}\n\n${message.body}\n`;
};

// Answers the requests `answers` matches in GitHub's place.
const answering =
  (answers: (method: string, path: string, query: string) => Option.Option<Answer>) =>
  (method: string, path: string, body: { readonly query?: string }) =>
    answers(method, path, body.query ?? "");

const DATE = "2026-11-17T12:00:00Z";

// `answer`, for a request that `matches`.
const answerIf = (matches: boolean, answer: Answer) =>
  Option.filter(Option.some(answer), () => matches);

describe("the protected-branch adapter's requests", () => {
  effect("a write that lands is the last request its advance sends", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      const progress = yield* adapterOver(fake);

      const asked = yield* progress.advance("pr-73", { from: Option.none(), to: ASKED, by: RUN_A });

      expect(fake.state.requests).toEqual([
        "graphql ref",
        `POST /repos/${SLUG}/git/commits`,
        `POST /repos/${SLUG}/git/refs`,
      ]);

      fake.state.requests.length = 0;
      yield* progress.advance("pr-73", { from: Option.some(asked), to: CHANGES, by: RUN_B });

      expect(fake.state.requests).toEqual(["graphql ref", "graphql createCommitOnBranch"]);
    }),
  );

  effect("a retry that finds its own write sends no write", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      const progress = yield* adapterOver(fake);
      const first = { from: Option.none(), to: ASKED, by: RUN_A };
      const asked = yield* progress.advance("pr-73", first);

      fake.state.requests.length = 0;

      expect(yield* progress.advance("pr-73", first)).toEqual(asked);
      expect(fake.state.requests).toEqual(["graphql ref"]);

      const later = { from: Option.some(asked), to: CHANGES, by: RUN_B };
      const changes = yield* progress.advance("pr-73", later);

      fake.state.requests.length = 0;

      expect(yield* progress.advance("pr-73", later)).toEqual(changes);
      expect(fake.state.requests).toEqual(["graphql ref"]);
    }),
  );

  // The two writers interleave: one has made its root commit when the other
  // creates the branch, so the first's ref is the one GitHub turns away.
  effect("a first phase whose ref another writer created first is a lost race", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      const progress = yield* adapterOver(fake);

      fake.state.beforeNextRef = Option.some(() => {
        fake.advanceAs(`${THREADS}pr-73`, messageOf("pr-73", Option.none(), CHANGES, RUN_B));
      });

      const exit = yield* Effect.exit(
        progress.advance("pr-73", { from: Option.none(), to: ASKED, by: RUN_A }),
      );

      expect(movedTo(exit)).toEqual(Option.some(Option.some(CHANGES)));
      expect(Option.map(yield* progress.read("pr-73"), what)).toEqual(
        Option.some([CHANGES, RUN_B]),
      );
    }),
  );

  effect("a first phase whose ref its own earlier attempt created is that attempt's record", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      const progress = yield* adapterOver(fake);
      const landed: Array<string> = [];

      fake.state.beforeNextRef = Option.some(() => {
        landed.push(
          fake.advanceAs(`${THREADS}pr-73`, messageOf("pr-73", Option.none(), ASKED, RUN_A)),
        );
      });

      const record = yield* progress.advance("pr-73", {
        from: Option.none(),
        to: ASKED,
        by: RUN_A,
      });

      expect([record.version]).toEqual(landed);
    }),
  );

  effect("readAll reads every page of threads, each once, and skips a branch below an item's", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      const items = Arr.makeBy(150, (index) => `pr-${index}`);

      for (const item of items) {
        fake.advanceAs(`${THREADS}${item}`, messageOf(item, Option.none(), ASKED, RUN_A));
      }

      fake.advanceAs(`${THREADS}pr-3/old`, messageOf("pr-3", Option.none(), CHANGES, RUN_B));
      const progress = yield* adapterOver(fake);

      const all = yield* progress.readAll;

      expect(Arr.sort([...all.keys()], Order.String)).toEqual(Arr.sort(items, Order.String));
      expect(fake.state.requests.filter((request) => request === "graphql refs").length).toBe(2);
    }),
  );
});

describe("the protected-branch adapter's errors", () => {
  for (const [object, path] of [
    ["a blob", `/repos/${SLUG}/git/blobs`],
    ["a tree", `/repos/${SLUG}/git/trees`],
    ["a commit", `/repos/${SLUG}/git/commits`],
  ] as const) {
    for (const status of [403, 404]) {
      effect(`HTTP ${status} creating ${object} is a setup error`, () =>
        Effect.gen(function* () {
          const fake = makeThreadsFake(SLUG);
          const progress = yield* adapterOver(fake);

          fake.state.respond = answering((method, at) =>
            answerIf(method === "POST" && at === path, {
              status,
              body: { message: "Resource not accessible by integration" },
            }),
          );

          const exit = yield* Effect.exit(
            progress.advance("pr-73", {
              from: Option.none(),
              to: ASKED,
              by: RUN_A,
              blobs: ["the plan"],
            }),
          );

          expect(refused(exit)).toEqual(Option.some(true));
        }),
      );
    }
  }

  const creatingRef = (status: number, body: Json) =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      const progress = yield* adapterOver(fake);

      fake.state.respond = answering((method, path) =>
        answerIf(method === "POST" && path === `/repos/${SLUG}/git/refs`, { status, body }),
      );

      return yield* Effect.exit(
        progress.advance("pr-73", { from: Option.none(), to: ASKED, by: RUN_A }),
      );
    });

  effect("HTTP 403 creating a thread's ref is a setup error", () =>
    Effect.map(creatingRef(403, { message: "Resource not accessible by integration" }), (exit) => {
      expect(refused(exit)).toEqual(Option.some(true));
    }),
  );

  // Only GitHub's refusal is a setup error: a 422 for another reason, or a
  // server's error, whatever it says, is a write that failed.
  for (const [status, body] of [
    [422, { message: "Object does not exist" }],
    [500, { message: "Server error while evaluating repository rules" }],
    [502, NULL],
    [422, { message: 422 }],
  ] as const) {
    effect(
      `HTTP ${status} creating a thread's ref, saying ${printJson(body)}, is a ProgressError`,
      () =>
        Effect.map(creatingRef(status, body), (exit) => {
          expect(failedWith(exit)).toEqual(Option.some("ProgressError"));
        }),
    );
  }

  const advancingAnswered = (body: Json) =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      const progress = yield* adapterOver(fake);
      const asked = yield* progress.advance("pr-73", { from: Option.none(), to: ASKED, by: RUN_A });

      fake.state.respond = answering((_, path, query) =>
        answerIf(path === "/graphql" && query.includes("createCommitOnBranch"), {
          status: 200,
          body,
        }),
      );

      return yield* Effect.exit(
        progress.advance("pr-73", { from: Option.some(asked), to: CHANGES, by: RUN_B }),
      );
    });

  // On a branch that hasn't moved, only FORBIDDEN is a ruleset's refusal.
  for (const errors of [
    [{ type: "INTERNAL", message: "Something went wrong while executing your query." }],
    [{ message: "Something went wrong while executing your query." }],
    [],
  ]) {
    effect(
      `an advance answered with ${printJson(errors)} on an unmoved branch is a ProgressError`,
      () =>
        Effect.map(advancingAnswered({ data: { createCommitOnBranch: NULL }, errors }), (exit) => {
          expect(failedWith(exit)).toEqual(Option.some("ProgressError"));
        }),
    );
  }

  effect("a GitHub call that fails is a ProgressError", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      const progress = yield* adapterOver(fake);

      fake.state.respond = answering((method, path) =>
        answerIf(method === "POST" && path === "/graphql", {
          status: 502,
          body: { message: "Bad Gateway" },
        }),
      );

      expect(failedWith(yield* Effect.exit(progress.read("pr-73")))).toEqual(
        Option.some("ProgressError"),
      );
      expect(failedWith(yield* Effect.exit(progress.readAll))).toEqual(
        Option.some("ProgressError"),
      );
    }),
  );

  effect("a branch whose tip GitHub gives no date is a ProgressError", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);
      const progress = yield* adapterOver(fake);

      fake.state.respond = answering((_, path, query) =>
        answerIf(path === "/graphql" && query.includes("ref(qualifiedName"), {
          status: 200,
          body: {
            data: {
              repository: {
                ref: {
                  target: {
                    oid: "1".repeat(40),
                    message: messageOf("pr-73", Option.none(), ASKED, RUN_A),
                  },
                },
              },
            },
          },
        }),
      );

      expect(failedWith(yield* Effect.exit(progress.read("pr-73")))).toEqual(
        Option.some("ProgressError"),
      );
    }),
  );

  effect("a record that names a blob its commit doesn't hold is a ProgressError", () =>
    Effect.gen(function* () {
      const fake = makeThreadsFake(SLUG);

      fake.advanceAs(
        `${THREADS}pr-73`,
        `chernabog: pr-73 review-asked\n\nPhase: review-asked\nBy: x\nBlobs: ${PLAN_HASH}\n`,
      );

      const progress = yield* adapterOver(fake);

      expect(failedWith(yield* Effect.exit(progress.blob("pr-73", PLAN_HASH)))).toEqual(
        Option.some("ProgressError"),
      );
    }),
  );
});

// A response GitHub wouldn't send, to each request the adapter reads, is a
// ProgressError: never a defect, and never a record made of what is missing.
describe("the protected-branch adapter on a malformed response", () => {
  const TIP = { oid: "1".repeat(40), message: "Phase: review-asked\nBy: x", committedDate: DATE };

  const graphqlAnswer = (asking: string, body: Json) => (_: string, path: string, query: string) =>
    answerIf(path === "/graphql" && query.includes(asking), { status: 200, body });

  const restAnswer =
    (route: string, status: number, body: Json) => (method: string, path: string) =>
      answerIf(`${method} ${path}`.startsWith(route), { status, body });

  const reading = (progress: Progress["Service"]) => progress.read("pr-73");
  const readingAll = (progress: Progress["Service"]) => progress.readAll;

  const firstPhase = (progress: Progress["Service"]) =>
    progress.advance("pr-73", { from: Option.none(), to: ASKED, by: RUN_A, blobs: ["the plan"] });

  const laterPhase = (progress: Progress["Service"]) =>
    Effect.flatMap(firstPhase(progress), (asked) =>
      progress.advance("pr-73", { from: Option.some(asked), to: CHANGES, by: RUN_B }),
    );

  const readingBlob = (progress: Progress["Service"]) =>
    Effect.flatMap(firstPhase(progress), () => progress.blob("pr-73", PLAN_HASH));

  const pageOf = (nodes: Json) => ({
    data: {
      repository: { refs: { nodes, pageInfo: { hasNextPage: false, endCursor: NULL } } },
    },
  });

  const cases: ReadonlyArray<
    readonly [
      string,
      (method: string, path: string, query: string) => Option.Option<Answer>,
      (progress: Progress["Service"]) => Effect.Effect<unknown, { readonly _tag: string }>,
    ]
  > = [
    [
      "a branch's tip without an oid",
      graphqlAnswer("ref(qualifiedName", {
        data: { repository: { ref: { target: { message: TIP.message, committedDate: DATE } } } },
      }),
      reading,
    ],
    [
      "a ref without its target",
      graphqlAnswer("ref(qualifiedName", { data: { repository: { ref: {} } } }),
      reading,
    ],
    ["refs without a repository", graphqlAnswer("refs(refPrefix", { data: {} }), readingAll],
    [
      "a repository without its refs",
      graphqlAnswer("refs(refPrefix", { data: { repository: {} } }),
      readingAll,
    ],
    [
      "refs without their nodes",
      graphqlAnswer("refs(refPrefix", {
        data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: NULL } } } },
      }),
      readingAll,
    ],
    [
      "a ref without its name",
      graphqlAnswer("refs(refPrefix", pageOf([{ target: TIP }])),
      readingAll,
    ],
    [
      "a page without hasNextPage",
      graphqlAnswer("refs(refPrefix", {
        data: { repository: { refs: { nodes: [], pageInfo: { endCursor: NULL } } } },
      }),
      readingAll,
    ],
    [
      "an advance's commit without an oid",
      graphqlAnswer("createCommitOnBranch", {
        data: { createCommitOnBranch: { commit: { committedDate: DATE } } },
      }),
      laterPhase,
    ],
    [
      "an advance's error without a message",
      graphqlAnswer("createCommitOnBranch", {
        data: { createCommitOnBranch: NULL },
        errors: [{ type: "FORBIDDEN" }],
      }),
      laterPhase,
    ],
    [
      "a made blob without its sha",
      restAnswer(`POST /repos/${SLUG}/git/blobs`, 201, { url: "somewhere" }),
      firstPhase,
    ],
    [
      "a made commit without its sha",
      restAnswer(`POST /repos/${SLUG}/git/commits`, 201, { committer: { date: DATE } }),
      firstPhase,
    ],
    [
      "a made commit whose date isn't a string",
      restAnswer(`POST /repos/${SLUG}/git/commits`, 201, {
        sha: "2".repeat(40),
        committer: { date: 1_700_000_000_000 },
      }),
      firstPhase,
    ],
    [
      "a blob's object without its oid",
      // And the blobs API answers, whichever blob is asked for.
      (method, path, query) =>
        Option.orElse(
          graphqlAnswer("object(expression", { data: { repository: { object: {} } } })(
            method,
            path,
            query,
          ),
          () =>
            restAnswer(`GET /repos/${SLUG}/git/blobs/`, 200, { content: "", encoding: "base64" })(
              method,
              path,
            ),
        ),
      readingBlob,
    ],
    [
      "a blob without its content",
      restAnswer(`GET /repos/${SLUG}/git/blobs/`, 200, { encoding: "base64" }),
      readingBlob,
    ],
  ];

  for (const [said, answers, doing] of cases) {
    effect(`${said} is a ProgressError`, () =>
      Effect.gen(function* () {
        const fake = makeThreadsFake(SLUG);
        const progress = yield* adapterOver(fake);

        fake.state.respond = answering(answers);

        expect(failedWith(yield* Effect.exit(doing(progress)))).toEqual(
          Option.some("ProgressError"),
        );
      }),
    );
  }
});
