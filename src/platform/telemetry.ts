// Spans and logs, appended as JSON lines to a file of this process's for each
// UTC day: <dir>/<YYYY-MM-DD>/<process>-<pid>.jsonl. One file per process, so
// the daemon and the CLI calls beside it never write into the same one, and a
// day's records sit in one folder that retention can delete whole.
//
// A record is buffered when it happens (a span when it ends, a log when it's
// logged) and written on an interval and when the layer's scope closes, so a
// CLI call that ends at once loses nothing. Writing is best effort: a failure
// is said on stderr once and its records are dropped, never failing the
// program they describe.
//
// A spoke (ADR 23, decision 4) names its files for its run,
// <dir>/<YYYY-MM-DD>/spoke-<run>-<pid>.jsonl, and is given a limit: the bytes
// its run's files may hold, summed over every day folder. At the limit it
// writes one last line saying it stopped, and drops everything after, so no
// flood grows a run's telemetry past its bound on any day.

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Formatter from "effect/Formatter";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Tracer from "effect/Tracer";

import { formatBytes } from "../kernel/spoke-bounds.value-object.ts";

// Which process writes: the daemon, a CLI call, or one run's spoke.
export type TelemetryProcess = "daemon" | "cli" | `spoke-${string}`;

export type FileTelemetryOptions = {
  // The folder the day folders go in.
  readonly dir: string;
  readonly process: TelemetryProcess;
  // The bytes every file of this process's name may hold, over every day
  // folder: a spoke's bound. None for no limit.
  readonly limit?: Option.Option<number>;
  // Where the one warning about a failed write goes; stderr by default.
  readonly warn?: (line: string) => void;
};

// What a process writes telemetry as, and its limit, from the arguments its
// command line is parsed from: a spoke (`ci run --run <run>`) as its run,
// limited by `--telemetry-limit <bytes>`; the daemon; or a CLI call.
export const telemetryOfArgs = (
  args: ReadonlyArray<string>,
): { readonly process: TelemetryProcess; readonly limit: Option.Option<number> } => {
  const valueOf = (flag: string) =>
    Option.flatMap(
      Option.liftPredicate(args.indexOf(flag), (at) => at >= 0),
      (at) => Option.fromUndefinedOr(args[at + 1]),
    );

  const spokeOf = Option.flatMap(
    Option.liftPredicate(args, (given) => given[0] === "ci" && given[1] === "run"),
    () => valueOf("--run"),
  );

  return Option.match(spokeOf, {
    onSome: (run) => ({
      process: `spoke-${run}`,
      limit: Option.filter(
        Option.map(valueOf("--telemetry-limit"), Number),
        (bytes) => Number.isFinite(bytes) && bytes >= 0,
      ),
    }),
    onNone: () => ({
      process: Option.match(
        Option.filter(Option.fromUndefinedOr(args[0]), (command) => command === "daemon"),
        { onNone: () => "cli" as const, onSome: () => "daemon" as const },
      ),
      limit: Option.none(),
    }),
  });
};

type SpanStatus = "ok" | "error" | "unfinished";

// A record waiting to be written, with the UTC day it was written on.
type Pending = { readonly day: string; readonly line: string };

const FLUSH_EVERY = "1 second";

const NANOS_PER_MILLI = BigInt(1_000_000);

const dateOfNanos = (nanos: bigint) => new Date(Number(nanos / NANOS_PER_MILLI));

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

const bytesOf = (line: string) => Buffer.byteLength(line) + 1;

const stderr = (line: string) => {
  process.stderr.write(`${line}\n`);
};

const attributesOf = (span: Tracer.Span) => Object.fromEntries(span.attributes);

const spanLine = (
  span: Tracer.Span,
  endTime: bigint,
  status: SpanStatus,
  error: Option.Option<string>,
) => {
  const startTime = span.status.startTime;

  return Formatter.formatJson({
    type: "span",
    traceId: span.traceId,
    spanId: span.spanId,
    ...Option.match(span.parent, {
      onNone: () => ({}),
      onSome: (parent) => ({ parentSpanId: parent.spanId }),
    }),
    name: span.name,
    startTime: dateOfNanos(startTime).toISOString(),
    endTime: dateOfNanos(endTime).toISOString(),
    durationMs: Number(endTime - startTime) / 1_000_000,
    status,
    attributes: attributesOf(span),
    ...Option.match(error, { onNone: () => ({}), onSome: (cause) => ({ error: cause }) }),
  });
};

// A span that hands itself to `ended` when it ends.
class RecordedSpan extends Tracer.NativeSpan {
  readonly #ended: (span: RecordedSpan, endTime: bigint, exit: Exit.Exit<unknown, unknown>) => void;

  constructor(
    options: ConstructorParameters<typeof Tracer.NativeSpan>[0],
    ended: (span: RecordedSpan, endTime: bigint, exit: Exit.Exit<unknown, unknown>) => void,
  ) {
    super(options);
    this.#ended = ended;
  }

  public override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit);
    this.#ended(this, endTime, exit);
  }
}

const make = (options: FileTelemetryOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const warn = options.warn ?? stderr;
    const fileName = `${options.process}-${process.pid}.jsonl`;
    const writing = yield* Semaphore.make(1);

    const pending: Array<Pending> = [];
    const open = new Set<RecordedSpan>();
    let warned = false;
    const limit = options.limit ?? Option.none<number>();
    // The bytes this process's name holds, counted from the files already
    // there at the first write; none until then, or with no limit.
    let used = Option.none<number>();
    let stopped = false;

    const warnOnce = (line: string) => {
      if (!warned) {
        warned = true;
        warn(line);
      }
    };

    const ended = (span: RecordedSpan, endTime: bigint, exit: Exit.Exit<unknown, unknown>) => {
      open.delete(span);

      if (!span.sampled) {
        return;
      }

      const line = Exit.match(exit, {
        onSuccess: () => spanLine(span, endTime, "ok", Option.none()),
        onFailure: (cause) => spanLine(span, endTime, "error", Option.some(Cause.pretty(cause))),
      });

      pending.push({ day: dayOf(dateOfNanos(endTime)), line });
    };

    const tracer = Tracer.make({
      span: (spanOptions) => {
        const span = new RecordedSpan(spanOptions, ended);
        open.add(span);

        return span;
      },
    });

    const logger = Logger.make((log) => {
      const structured = Logger.formatStructured.log(log);
      const span = Option.fromNullishOr(log.fiber.cache.span);

      const line = Formatter.formatJson({
        type: "log",
        time: structured.timestamp,
        level: structured.level,
        message: structured.message,
        annotations: structured.annotations,
        ...Option.match(Option.fromNullishOr(structured.cause), {
          onNone: () => ({}),
          onSome: (cause) => ({ cause }),
        }),
        ...Option.match(span, {
          onNone: () => ({}),
          onSome: (current) => ({ traceId: current.traceId, spanId: current.spanId }),
        }),
      });

      pending.push({ day: dayOf(log.date), line });
    });

    // What every file of this process's name already holds, in every day
    // folder: a spoke's earlier files count toward its bound.
    const heldAlready = Effect.gen(function* () {
      if (!(yield* fs.exists(options.dir))) {
        return 0;
      }

      let total = 0;

      for (const day of yield* fs.readDirectory(options.dir)) {
        const files = yield* fs
          .readDirectory(`${options.dir}/${day}`)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

        for (const file of files.filter((name) => name.startsWith(`${options.process}-`))) {
          const info = yield* fs.stat(`${options.dir}/${day}/${file}`).pipe(Effect.option);
          total += Option.match(info, { onNone: () => 0, onSome: ({ size }) => Number(size) });
        }
      }

      return total;
    }).pipe(Effect.orElseSucceed(() => 0));

    // The line a limited process writes last, in place of the first that
    // would take it past its limit, `filler` long. It fills the files to just
    // past the bound, which is how the hub, measuring their size, knows the
    // spoke reached it (ADR 23, decision 4), whatever size the dropped line was.
    const stopLine = (bytes: number, at: Date, filler: number) =>
      Formatter.formatJson({
        type: "log",
        time: at.toISOString(),
        level: "WARN",
        message: `chernabog: ${options.process}'s telemetry stopped at its bound of ${formatBytes(bytes)}; what it records after is dropped`,
        annotations: {},
        filler: " ".repeat(filler),
      });

    // The lines that fit within the limit, and the stop line in place of the
    // first that doesn't, once; all of them with no limit.
    const withinLimit = (lines: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        if (Option.isNone(limit)) {
          return lines;
        }

        if (stopped) {
          return [];
        }

        let total = yield* Option.match(used, {
          onNone: () => heldAlready,
          onSome: Effect.succeed,
        });

        const kept: Array<string> = [];

        for (const line of lines) {
          if (total + bytesOf(line) > limit.value) {
            stopped = true;
            const at = new Date(yield* Clock.currentTimeMillis);
            const bare = bytesOf(stopLine(limit.value, at, 0));
            const last = stopLine(limit.value, at, Math.max(0, limit.value + 1 - total - bare));
            kept.push(last);
            total += bytesOf(last);
            warn(
              `chernabog: ${options.process}'s telemetry reached its bound of ${formatBytes(limit.value)}, and stops here`,
            );
            break;
          }

          kept.push(line);
          total += bytesOf(line);
        }

        used = Option.some(total);

        return kept;
      });

    const writeDay = (day: string, lines: ReadonlyArray<string>) => {
      const folder = `${options.dir}/${day}`;
      const file = `${folder}/${fileName}`;

      return fs.makeDirectory(folder, { recursive: true, mode: 0o700 }).pipe(
        Effect.andThen(
          fs.writeFileString(file, `${lines.join("\n")}\n`, { flag: "a", mode: 0o600 }),
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            warnOnce(
              `chernabog: telemetry couldn't be written to ${file}, and is being dropped: ${Cause.pretty(cause)}`,
            );
          }),
        ),
      );
    };

    // Takes everything buffered and writes it, a day's lines at a time. The
    // lines leave the buffer before the write, so once a flush starts it
    // finishes: an interrupted one would drop them.
    const flush = writing.withPermits(1)(
      Effect.uninterruptible(
        Effect.suspend(() => {
          const byDay = Map.groupBy(pending.splice(0), (record) => record.day);

          return Effect.forEach(
            byDay,
            ([day, records]) =>
              withinLimit(records.map((record) => record.line)).pipe(
                Effect.flatMap((lines) =>
                  Effect.when(writeDay(day, lines), Effect.succeed(lines.length > 0)),
                ),
              ),
            { discard: true },
          );
        }),
      ),
    );

    // The spans still open when the process stops, written as unfinished.
    const recordUnfinished = Effect.gen(function* () {
      const now = yield* Clock.currentTimeNanos;

      for (const span of open) {
        if (span.sampled) {
          pending.push({
            day: dayOf(dateOfNanos(now)),
            line: spanLine(span, now, "unfinished", Option.none()),
          });
        }
      }

      open.clear();
    });

    yield* Effect.addFinalizer(() => recordUnfinished.pipe(Effect.andThen(flush)));
    yield* Effect.forkScoped(flush.pipe(Effect.repeat(Schedule.spaced(FLUSH_EVERY))));

    return { tracer, logger };
  });

// The tracer and a logger beside the ones already installed, both writing to
// files under `options.dir` for as long as the layer's scope is open.
export const FileTelemetry = {
  layer: (options: FileTelemetryOptions): Layer.Layer<never, never, FileSystem.FileSystem> =>
    Layer.unwrap(
      make(options).pipe(
        Effect.map(({ logger, tracer }) =>
          Layer.mergeAll(
            Layer.succeed(Tracer.Tracer, tracer),
            Logger.layer([logger], { mergeWithExisting: true }),
          ),
        ),
      ),
    ),
};
