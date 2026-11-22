// `chernabog progress anomalies` over a fake of the repo's SDK's Ledger: what
// it lists, what acknowledging a record a person saw does, and what it says of
// an SDK it can't use.

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { effect } from "../../../../../test/effect-test.ts";
import {
  type Anomaly,
  type LedgerOf,
  parseSeen,
  type Seen,
  surveyAnomalies,
} from "./progress-anomalies.ts";

const REPO = "acme/app";

const UNKNOWN_WRITER: Anomaly = {
  item: "pr-184",
  phase: "approved",
  from: "review-asked",
  by: "mallory",
  version: "9bf23c1d0e5f",
  why: "mallory isn't a writer of acme/app's",
};

const UNDECLARED: Anomaly = {
  item: "issue-7",
  phase: "merged",
  by: "data-quail",
  version: "41aa07be93c2",
  why: "no flow moves an issue from planned to merged",
};

// An anomaly's item, as the fake reads what it's handed.
const itemOf = Schema.decodeUnknownSync(Schema.Struct({ item: Schema.String }));

// A repo's Ledger that lists `listed`, as the SDK gives it, and records again
// each anomaly it's handed unless its item is in `movesFirst`, whose record
// changes before the write, or answers `answers`. It keeps what it was handed.
const fakeLedger = (
  listed: ReadonlyArray<unknown>,
  {
    answers = Option.none(),
    movesFirst = [],
  }: {
    answers?: Option.Option<ReadonlyArray<unknown>>;
    movesFirst?: ReadonlyArray<string>;
  } = {},
) => {
  const handed: Array<ReadonlyArray<unknown>> = [];

  const ledger: LedgerOf<never> = {
    survey: Effect.succeed(listed),
    acknowledge: (anomalies: ReadonlyArray<unknown>) =>
      Effect.sync(() => {
        handed.push(anomalies);

        return Option.getOrElse(answers, () =>
          anomalies.map((anomaly) => {
            const { item } = itemOf(anomaly);

            return { anomaly: { item }, acknowledged: !movesFirst.includes(item) };
          }),
        );
      }),
  };

  return { ledger: Option.some(ledger), handed };
};

const seen = (item: string, version: string): Seen => ({ item, version });

describe("listing anomalies", () => {
  effect("lists every record the ledger's check fails, and acknowledges none", () =>
    Effect.gen(function* () {
      const { handed, ledger } = fakeLedger([UNKNOWN_WRITER, UNDECLARED]);
      const surveyed = yield* surveyAnomalies(REPO, ledger, []);

      expect(surveyed).toEqual({
        anomalies: [UNKNOWN_WRITER, UNDECLARED],
        acknowledged: [],
        moved: [],
      });
      expect(handed).toEqual([]);
    }),
  );

  effect("lists none for a ledger whose records all pass", () =>
    Effect.gen(function* () {
      const surveyed = yield* surveyAnomalies(REPO, fakeLedger([]).ledger, []);

      expect(surveyed.anomalies).toEqual([]);
    }),
  );
});

describe("acknowledging a record a person saw listed", () => {
  effect("records again one still at the version they saw", () =>
    Effect.gen(function* () {
      const { handed, ledger } = fakeLedger([UNKNOWN_WRITER, UNDECLARED]);
      const ack = seen("pr-184", UNKNOWN_WRITER.version);
      const surveyed = yield* surveyAnomalies(REPO, ledger, [ack]);

      expect(handed).toEqual([[UNKNOWN_WRITER]]);
      expect(surveyed).toEqual({
        anomalies: [UNKNOWN_WRITER, UNDECLARED],
        acknowledged: [ack],
        moved: [],
      });
    }),
  );

  effect("takes the start of the version, as the listing prints it", () =>
    Effect.gen(function* () {
      const { handed, ledger } = fakeLedger([UNKNOWN_WRITER, UNDECLARED]);
      const ack = seen("issue-7", "41aa07b");
      const surveyed = yield* surveyAnomalies(REPO, ledger, [ack]);

      expect(handed).toEqual([[UNDECLARED]]);
      expect(surveyed.acknowledged).toEqual([ack]);
      expect(surveyed.moved).toEqual([]);
    }),
  );

  effect("leaves one whose record has moved since they saw it, and hands the ledger none", () =>
    Effect.gen(function* () {
      const { handed, ledger } = fakeLedger([UNKNOWN_WRITER]);
      const old = seen("pr-184", "0c11d2e");
      const surveyed = yield* surveyAnomalies(REPO, ledger, [old]);

      expect(handed).toEqual([[]]);
      expect(surveyed.acknowledged).toEqual([]);
      expect(surveyed.moved).toEqual([old]);
    }),
  );

  effect("leaves one the version matches on another item", () =>
    Effect.gen(function* () {
      const { handed, ledger } = fakeLedger([UNKNOWN_WRITER]);
      const other = seen("pr-185", UNKNOWN_WRITER.version);
      const surveyed = yield* surveyAnomalies(REPO, ledger, [other]);

      expect(handed).toEqual([[]]);
      expect(surveyed.moved).toEqual([other]);
    }),
  );

  effect("leaves one whose record moves between the listing and the write", () =>
    Effect.gen(function* () {
      const { handed, ledger } = fakeLedger([UNKNOWN_WRITER, UNDECLARED], {
        movesFirst: ["pr-184"],
      });

      const raced = seen("pr-184", "9bf23c1");
      const kept = seen("issue-7", "41aa07b");
      const surveyed = yield* surveyAnomalies(REPO, ledger, [raced, kept]);

      expect(handed).toEqual([[UNKNOWN_WRITER, UNDECLARED]]);
      expect(surveyed.acknowledged).toEqual([kept]);
      expect(surveyed.moved).toEqual([raced]);
    }),
  );

  effect("counts an acknowledgement only for the item the ledger says it recorded", () =>
    Effect.gen(function* () {
      const { ledger } = fakeLedger([UNKNOWN_WRITER, UNDECLARED], {
        answers: Option.some([
          { anomaly: { item: "issue-7" }, acknowledged: true },
          { anomaly: { item: "pr-184" }, acknowledged: false },
        ]),
      });

      const left = seen("pr-184", "9bf23c1");
      const recorded = seen("issue-7", "41aa07b");
      const surveyed = yield* surveyAnomalies(REPO, ledger, [left, recorded]);

      expect(surveyed.acknowledged).toEqual([recorded]);
      expect(surveyed.moved).toEqual([left]);
    }),
  );
});

describe("a repo's SDK it can't use", () => {
  effect("refuses one from before the ledger, saying how to move it on", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(surveyAnomalies(REPO, Option.none<LedgerOf<never>>(), []));

      expect(refused._tag).toBe("ConfigError");
      expect(refused.message).toBe(
        "acme/app's @chernabog/sdk is from before sources checked the records they read; chernabog recipes upgrade moves it on",
      );
    }),
  );

  effect("refuses anomalies of the wrong shape, naming what it gave", () =>
    Effect.gen(function* () {
      const { item: _item, ...noItem } = UNKNOWN_WRITER;
      const refused = yield* Effect.flip(surveyAnomalies(REPO, fakeLedger([noItem]).ledger, []));

      expect(refused._tag).toBe("ConfigError");
      expect(refused.message).toStartWith(
        "the repo's @chernabog/sdk gave anomalies this can't read: ",
      );
    }),
  );

  effect("refuses an anomaly whose `from` isn't text", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(
        surveyAnomalies(REPO, fakeLedger([{ ...UNKNOWN_WRITER, from: 3 }]).ledger, []),
      );

      expect(refused.message).toStartWith("the repo's @chernabog/sdk gave anomalies");
    }),
  );

  effect("refuses an acknowledgement of the wrong shape, naming what it gave", () =>
    Effect.gen(function* () {
      const answers = [[{ anomaly: {}, acknowledged: true }], [{ anomaly: { item: "pr-184" } }]];

      for (const answer of answers) {
        const { ledger } = fakeLedger([UNKNOWN_WRITER], { answers: Option.some(answer) });

        const refused = yield* Effect.flip(
          surveyAnomalies(REPO, ledger, [seen("pr-184", "9bf23c1")]),
        );

        expect(refused._tag).toBe("ConfigError");
        expect(refused.message).toStartWith(
          "the repo's @chernabog/sdk gave what it acknowledged this can't read: ",
        );
      }
    }),
  );

  effect("passes on the ledger's own failure as it said it", () =>
    Effect.gen(function* () {
      const ledger: LedgerOf<never> = {
        survey: Effect.fail({ message: "the ledger's ref is unreadable" }),
        acknowledge: () => Effect.succeed([]),
      };

      const refused = yield* Effect.flip(surveyAnomalies(REPO, Option.some(ledger), []));

      expect(refused._tag).toBe("ConfigError");
      expect(refused.message).toBe("the ledger's ref is unreadable");
    }),
  );
});

describe("a record as `--acknowledge` takes it", () => {
  test("is an item and a version, around whitespace", () => {
    expect(parseSeen("pr-184@9bf23c1")).toEqual(Option.some(seen("pr-184", "9bf23c1")));
    expect(parseSeen("  pr-184@9bf23c1\n")).toEqual(Option.some(seen("pr-184", "9bf23c1")));
  });

  test("is nothing else: no text before or after it, and no part missing", () => {
    for (const text of [
      "x pr-184@9bf23c1",
      "pr-184@9bf23c1 x",
      "pr-184@9bf23c1!",
      "#pr-184 @9bf23c1",
      "pr-184",
      "pr-184@",
      "@9bf23c1",
      "",
    ]) {
      expect(parseSeen(text)).toEqual(Option.none());
    }
  });
});
