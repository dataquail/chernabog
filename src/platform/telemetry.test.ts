import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { effect } from "../../test/effect-test.ts";
import { FileTelemetry } from "./telemetry.ts";

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
});
