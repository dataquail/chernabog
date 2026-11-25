import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { effect } from "../../test/effect-test.ts";
import { formatBytes } from "../kernel/spoke-bounds.value-object.ts";
import { TELEMETRY_RETENTION } from "./retention.ts";
import {
  dayCapping,
  FileTelemetry,
  type FileTelemetryOptions,
  telemetryOfArgs,
} from "./telemetry.ts";

// What a test reads of a line, decoded as any reader of the files would.
const TelemetryLine = Schema.Struct({
  type: Schema.Literals(["span", "log"]),
  name: Schema.optional(Schema.String),
  traceId: Schema.optional(Schema.String),
  spanId: Schema.optional(Schema.String),
  parentSpanId: Schema.optional(Schema.String),
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Finite),
  status: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  attributes: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  time: Schema.optional(Schema.String),
  level: Schema.optional(Schema.String),
  message: Schema.optional(Schema.Json),
  annotations: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
});

type TelemetryRecord = typeof TelemetryLine.Type;

const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(TelemetryLine));

const scratch = FileSystem.FileSystem.use((fs) =>
  fs.makeTempDirectoryScoped({ prefix: "chernabog-telemetry-" }),
);

// Runs `program` as a CLI call would: the telemetry layer's scope opens around
// it and closes the moment it ends.
const traced = <A, E>(
  dir: string,
  program: Effect.Effect<A, E>,
  warn: (line: string) => void = () => {},
) => program.pipe(Effect.provide(FileTelemetry.layer({ dir, process: "cli", warn })));

// Every record under `dir`, by the day folder it was written in.
const recordsByDay = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const byDay: Record<string, Array<TelemetryRecord>> = {};

    for (const day of (yield* fs.readDirectory(dir)).toSorted()) {
      const files = yield* fs.readDirectory(`${dir}/${day}`);
      expect(files).toEqual([`cli-${process.pid}.jsonl`]);

      const text = yield* fs.readFileString(`${dir}/${day}/${files[0]}`);
      byDay[day] = yield* Effect.forEach(
        text.split("\n").filter((line) => line.length > 0),
        (line) => decodeLine(line),
      );
    }

    return byDay;
  });

const allRecords = (dir: string) =>
  recordsByDay(dir).pipe(Effect.map((byDay) => Object.values(byDay).flat()));

const spanNamed = (records: ReadonlyArray<TelemetryRecord>, name: string) =>
  records.find((record) => record.type === "span" && record.name === name);

const inner = Effect.fn("inner")(function* () {
  yield* Effect.annotateCurrentSpan("run.id", "run-1");
  yield* Effect.log("inside inner").pipe(Effect.annotateLogs("repo", "dataquail/chernabog"));
});

const outer = Effect.fn("outer")(function* () {
  yield* inner();
});

const failing = Effect.fn("failing")(function* () {
  return yield* Effect.fail("the disk is full");
});

describe("FileTelemetry", () => {
  effect("a nested Effect.fn writes parent and child spans of one trace", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;

      yield* traced(dir, outer());

      const records = yield* allRecords(dir);
      const parent = spanNamed(records, "outer");
      const child = spanNamed(records, "inner");

      expect(parent).toMatchObject({ type: "span", status: "ok" });
      expect(child).toMatchObject({
        type: "span",
        status: "ok",
        traceId: parent?.traceId,
        parentSpanId: parent?.spanId,
        attributes: { "run.id": "run-1" },
      });
      expect(typeof child?.durationMs).toBe("number");
      expect(Date.parse(String(child?.startTime))).toBeLessThanOrEqual(
        Date.parse(String(child?.endTime)),
      );
    }),
  );

  effect("a failing span records an error status and its cause", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;

      yield* traced(dir, failing().pipe(Effect.ignore));

      const span = spanNamed(yield* allRecords(dir), "failing");

      expect(span).toMatchObject({ type: "span", status: "error" });
      expect(String(span?.error)).toContain("the disk is full");
    }),
  );

  effect("a log inside a span carries that span's ids and its annotations", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;

      yield* traced(dir, Effect.log("outside").pipe(Effect.andThen(outer())));

      const records = yield* allRecords(dir);
      const span = spanNamed(records, "inner");
      const logs = records.filter((record) => record.type === "log");

      expect(logs.find((log) => log.message === "inside inner")).toMatchObject({
        level: "INFO",
        traceId: span?.traceId,
        spanId: span?.spanId,
        annotations: { repo: "dataquail/chernabog" },
      });

      const outside = logs.find((log) => log.message === "outside");
      expect(outside).toBeDefined();
      expect(outside?.traceId).toBeUndefined();
      expect(typeof outside?.time).toBe("string");
    }),
  );

  effect("records written either side of midnight land in two day folders", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;

      yield* TestClock.setTime(Date.parse("2026-10-31T23:59:30Z"));

      yield* traced(
        dir,
        Effect.gen(function* () {
          yield* Effect.log("before midnight");
          yield* TestClock.adjust("1 minute");
          yield* Effect.log("after midnight");
        }),
      );

      const byDay = yield* recordsByDay(dir);

      expect(Object.keys(byDay)).toEqual(["2026-10-31", "2026-11-01"]);
      expect(byDay["2026-10-31"]?.map((record) => record.message)).toEqual(["before midnight"]);
      expect(byDay["2026-11-01"]?.map((record) => record.message)).toEqual(["after midnight"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  effect("a scope that closes at once still flushes, and its files are private", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = `${yield* scratch}/telemetry`;

      yield* traced(dir, Effect.log("quick"));

      const records = yield* allRecords(dir);
      expect(records.map((record) => record.message)).toEqual(["quick"]);

      const [day] = yield* fs.readDirectory(dir);
      const folder = yield* fs.stat(`${dir}/${day}`);
      const file = yield* fs.stat(`${dir}/${day}/cli-${process.pid}.jsonl`);

      expect(folder.mode & 0o777).toBe(0o700);
      expect(file.mode & 0o777).toBe(0o600);
    }),
  );

  effect("a span still open when the scope closes is written as unfinished", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;

      yield* traced(
        dir,
        // Started and never ended, as a span a process exits inside is.
        Effect.makeSpan("forever"),
      );

      expect(spanNamed(yield* allRecords(dir), "forever")).toMatchObject({
        status: "unfinished",
      });
    }),
  );

  effect("an unwritable directory never fails the program, and says so once", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* scratch;
      const blocker = `${root}/not-a-directory`;
      yield* fs.writeFileString(blocker, "");

      const warnings: Array<string> = [];

      const result = yield* traced(
        `${blocker}/telemetry`,
        Effect.gen(function* () {
          yield* outer();
          yield* Effect.log("one more");

          return "finished";
        }),
        (line) => warnings.push(line),
      );

      expect(result).toBe("finished");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("telemetry");
    }),
  );

  // A spoke's telemetry, limited to its bound (ADR 23, decision 4): every
  // file of its run's, the bytes in each.
  const spokeFiles = (dir: string, run: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files: Array<{ path: string; text: string }> = [];

      for (const day of (yield* fs.readDirectory(dir)).toSorted()) {
        for (const name of yield* fs.readDirectory(`${dir}/${day}`)) {
          if (name.startsWith(`spoke-${run}-`)) {
            const path = `${dir}/${day}/${name}`;
            files.push({ path, text: yield* fs.readFileString(path) });
          }
        }
      }

      return files;
    });

  const flooding = Effect.forEach(
    Array.from({ length: 200 }, (_, at) => at),
    (at) => Effect.log(`flood ${at} ${"x".repeat(200)}`),
    { discard: true },
  );

  // A run's spoke flooding its telemetry, limited to 10 kB.
  const asSpoke = (dir: string, run: string, warn: (line: string) => void = () => {}) =>
    flooding.pipe(
      Effect.provide(
        FileTelemetry.layer({ dir, process: `spoke-${run}`, limit: Option.some(10_000), warn }),
      ),
    );

  effect("a spoke's telemetry stops at its bound, with one line saying so", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const warnings: Array<string> = [];

      yield* asSpoke(dir, "run-1", (line) => warnings.push(line));

      const files = yield* spokeFiles(dir, "run-1");

      expect(files.map((file) => file.path.endsWith(`/spoke-run-1-${process.pid}.jsonl`))).toEqual([
        true,
      ]);

      const lines = String(files[0]?.text)
        .split("\n")
        .filter((line) => line.length > 0);

      const last = yield* decodeLine(String(lines.at(-1)));

      expect(last).toMatchObject({ type: "log", level: "WARN" });
      expect(String(last.message)).toContain("telemetry stopped at its bound of 10 kB");
      // Everything before the stop line fits within the bound.
      expect(Buffer.byteLength(lines.slice(0, -1).join("\n")) + 1).toBeLessThanOrEqual(10_000);
      expect(lines.length).toBeLessThan(200);
      // The stop line takes the file past the bound, so the hub sees it there,
      // and by no more than itself.
      expect(Buffer.byteLength(String(files[0]?.text))).toBeGreaterThan(10_000);
      expect(Buffer.byteLength(String(files[0]?.text))).toBeLessThan(10_000 + 400);
      expect(warnings).toHaveLength(1);
    }),
  );

  effect("a spoke's files on earlier days count toward its bound", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      // Another day's file of the same run, already at the bound, and another
      // run's, which doesn't count.
      yield* fs.makeDirectory(`${dir}/2026-01-01`, { recursive: true });
      yield* fs.writeFileString(`${dir}/2026-01-01/spoke-run-2-1.jsonl`, "y".repeat(9_990));
      yield* fs.writeFileString(`${dir}/2026-01-01/spoke-run-3-1.jsonl`, "z".repeat(50_000));

      yield* asSpoke(dir, "run-2");

      const written = (yield* spokeFiles(dir, "run-2")).filter(
        (file) => !file.path.includes("2026-01-01"),
      );

      expect(written).toHaveLength(1);

      // A later process of the run, past the bound already, writes no second stop line.
      yield* asSpoke(dir, "run-2");
      expect(
        (yield* spokeFiles(dir, "run-2")).filter((file) => !file.path.includes("2026-01-01")),
      ).toEqual(written);

      const lines = String(written[0]?.text)
        .split("\n")
        .filter((line) => line.length > 0);

      expect(lines).toHaveLength(1);
      expect(String((yield* decodeLine(String(lines[0]))).message)).toContain("stopped");
    }),
  );

  effect("a process with no limit writes everything", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;

      yield* traced(dir, flooding);

      expect(yield* allRecords(dir)).toHaveLength(200);
    }),
  );

  // Runs `program` under the telemetry layer as `options` set it up.
  const tracedWith = <A, E, R>(options: FileTelemetryOptions, program: Effect.Effect<A, E, R>) =>
    program.pipe(Effect.provide(FileTelemetry.layer(options)));

  // A process with no bound of its own (the daemon or a CLI call), its day
  // capped at `dayCap`, saying it stopped on `warnings` and `notices`.
  const capped = <E, R>(
    dir: string,
    dayCap: number,
    program: Effect.Effect<void, E, R>,
    said: { warnings: Array<string>; notices: Array<string> } = { warnings: [], notices: [] },
  ) =>
    tracedWith(
      {
        dir,
        process: "daemon",
        dayCap,
        warn: (line) => said.warnings.push(line),
        notice: (line) => Effect.sync(() => said.notices.push(line)),
      },
      program,
    );

  // The text of every file in one day's folder, by name.
  const folder = (dir: string, day: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const texts: Record<string, string> = {};

      for (const name of (yield* fs.readDirectory(`${dir}/${day}`)).toSorted()) {
        texts[name] = yield* fs.readFileString(`${dir}/${day}/${name}`);
      }

      return texts;
    });

  const ownFile = `daemon-${process.pid}.jsonl`;

  const linesOf = (text: string) => text.split("\n").filter((line) => line.length > 0);

  // The lines of this process's own file in a day's folder; none without one.
  const ownLines = (texts: Readonly<Record<string, string>>) =>
    Option.match(Option.fromUndefinedOr(texts[ownFile]), {
      onNone: () => [],
      onSome: linesOf,
    });

  // Logs a line a second, so a long-running process's flushes each take one.
  const aLineASecond = (count: number, size: number) =>
    Effect.forEach(
      Array.from({ length: count }, (_, at) => at),
      (at) =>
        Effect.log(`line ${at} ${"x".repeat(size)}`).pipe(
          Effect.andThen(TestClock.adjust("1 second")),
        ),
      { discard: true },
    );

  effect("a day past its cap stops being written, and says so once, on stderr and the log", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const said = { warnings: new Array<string>(), notices: new Array<string>() };
      yield* TestClock.setTime(Date.parse("2026-11-22T12:00:00Z"));

      yield* capped(dir, 2_000, aLineASecond(20, 200), said);

      const texts = yield* folder(dir, "2026-11-22");
      const written = ownLines(texts);

      expect(written.length).toBeGreaterThan(0);
      expect(written.length).toBeLessThan(20);
      // What it wrote stays within the cap.
      expect(Buffer.byteLength(String(texts[ownFile]))).toBeLessThanOrEqual(2_000);
      expect(said.warnings).toHaveLength(1);
      expect(said.warnings[0]).toContain("writes no more telemetry until the next UTC day");
      expect(said.notices).toHaveLength(1);
      expect(said.notices[0]).toContain("writes no more telemetry until the next UTC day");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  effect("what other processes wrote to the day counts toward its cap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      const said = { warnings: new Array<string>(), notices: new Array<string>() };
      yield* TestClock.setTime(Date.parse("2026-11-22T12:00:00Z"));
      yield* fs.makeDirectory(`${dir}/2026-11-22`, { recursive: true });
      yield* fs.writeFileString(`${dir}/2026-11-22/cli-1.jsonl`, "y".repeat(1_900));

      yield* capped(dir, 2_000, aLineASecond(3, 200), said);

      expect(Object.keys(yield* folder(dir, "2026-11-22"))).toEqual(["cli-1.jsonl"]);
      expect(said.notices).toHaveLength(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  effect(
    "measures the folder when it first sees a day and once a minute after, its own writes added between",
    () =>
      Effect.gen(function* () {
        // What other processes' files in the folder hold, as a stat would find it.
        let others = 0;
        const measured: Array<string> = [];
        const stopped: Array<[string, number]> = [];
        yield* TestClock.setTime(Date.parse("2026-11-22T12:00:00Z"));

        const admit = dayCapping({
          cap: 1_000,
          measure: (day) =>
            Effect.sync(() => {
              measured.push(day);

              return others;
            }),
          stopped: (day, held) => Effect.sync(() => stopped.push([day, held])),
        });

        // Lines of 100 bytes each, as written with their newline.
        const lines = (count: number) => Array.from({ length: count }, () => "x".repeat(99));

        expect(yield* admit("2026-11-22", lines(2))).toHaveLength(2);
        // Another process writes beside it; within the minute, this one goes by
        // what it measured and what it wrote since.
        others = 850;
        expect(yield* admit("2026-11-22", lines(1))).toHaveLength(1);
        expect(measured).toEqual(["2026-11-22"]);

        // A minute on, it measures again: 850 and one line fit, the next doesn't.
        yield* TestClock.adjust("1 minute");
        expect(yield* admit("2026-11-22", lines(2))).toHaveLength(1);
        expect(measured).toEqual(["2026-11-22", "2026-11-22"]);
        expect(stopped).toEqual([["2026-11-22", 1_050]]);

        // Stopped, it measures nothing more that day and says nothing again.
        yield* TestClock.adjust("1 minute");
        expect(yield* admit("2026-11-22", lines(1))).toEqual([]);
        expect(measured).toHaveLength(2);
        expect(stopped).toHaveLength(1);

        // The next day is measured afresh and written.
        others = 0;
        expect(yield* admit("2026-11-23", lines(3))).toHaveLength(3);
        expect(measured).toEqual(["2026-11-22", "2026-11-22", "2026-11-23"]);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  effect("a capped day leaves the next UTC day to be written", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const said = { warnings: new Array<string>(), notices: new Array<string>() };
      yield* TestClock.setTime(Date.parse("2026-11-22T23:59:50Z"));

      yield* capped(
        dir,
        1_000,
        Effect.gen(function* () {
          yield* aLineASecond(5, 300);
          yield* TestClock.setTime(Date.parse("2026-11-23T00:00:30Z"));
          yield* aLineASecond(2, 100);
        }),
        said,
      );

      const capDay = ownLines(yield* folder(dir, "2026-11-22"));
      const nextDay = ownLines(yield* folder(dir, "2026-11-23"));

      expect(capDay.length).toBeLessThan(5);
      expect(nextDay).toHaveLength(2);
      expect(said.notices).toHaveLength(1);
      expect(said.notices[0]).toContain("2026-11-22");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  effect("with no day cap given, today's folder is held to the retention policy's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      const notices: Array<string> = [];
      yield* TestClock.setTime(Date.parse("2026-11-22T12:00:00Z"));
      yield* fs.makeDirectory(`${dir}/2026-11-22`, { recursive: true });
      // A sparse file, so the test writes next to nothing.
      yield* fs.writeFileString(`${dir}/2026-11-22/cli-1.jsonl`, "");
      yield* fs.truncate(`${dir}/2026-11-22/cli-1.jsonl`, TELEMETRY_RETENTION.maxBytes - 10);

      yield* tracedWith(
        {
          dir,
          process: "daemon",
          warn: () => {},
          notice: (line) => Effect.sync(() => notices.push(line)),
        },
        aLineASecond(1, 100),
      );

      expect(Object.keys(yield* folder(dir, "2026-11-22"))).toEqual(["cli-1.jsonl"]);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain(formatBytes(TELEMETRY_RETENTION.maxBytes));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  effect("a spoke keeps its own bound, whatever today's folder holds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* scratch;
      const today = new Date().toISOString().slice(0, 10);
      const warnings: Array<string> = [];
      yield* fs.makeDirectory(`${dir}/${today}`, { recursive: true });
      // Far past any day cap a test could give.
      yield* fs.writeFileString(`${dir}/${today}/daemon-1.jsonl`, "y".repeat(50_000));

      yield* tracedWith(
        {
          dir,
          process: "spoke-run-4",
          limit: Option.some(10_000),
          dayCap: 1_000,
          warn: (line) => warnings.push(line),
        },
        flooding,
      );

      const text = String((yield* spokeFiles(dir, "run-4"))[0]?.text);
      const lines = linesOf(text);

      // It writes to its bound, as a spoke without a day cap does, and says
      // only that it stopped there.
      expect(Buffer.byteLength(text)).toBeGreaterThan(10_000);
      expect(String((yield* decodeLine(String(lines.at(-1)))).message)).toContain(
        "telemetry stopped at its bound of 10 kB",
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("reached its bound");
    }),
  );
});

describe("telemetryOfArgs", () => {
  effect("names a spoke for its run, with its limit, and anything else the daemon or the CLI", () =>
    Effect.sync(() => {
      expect(
        telemetryOfArgs([
          "ci",
          "run",
          "--run",
          "abc",
          "--flow",
          "implement",
          "--telemetry-limit",
          "256000000",
        ]),
      ).toEqual({ process: "spoke-abc", limit: Option.some(256_000_000) });
      expect(telemetryOfArgs(["ci", "run", "--run", "abc"])).toEqual({
        process: "spoke-abc",
        limit: Option.none(),
      });
      expect(telemetryOfArgs(["ci", "run", "--flow", "implement"])).toEqual({
        process: "cli",
        limit: Option.none(),
      });
      expect(telemetryOfArgs(["daemon"])).toEqual({ process: "daemon", limit: Option.none() });
      expect(telemetryOfArgs(["status"])).toEqual({ process: "cli", limit: Option.none() });
    }),
  );
});
