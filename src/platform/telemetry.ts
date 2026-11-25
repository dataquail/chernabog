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
// A day is bounded as it is written, not only by the retention sweep, which
// never touches today's folder: once the folder holds more than `maxBytesPerDay`,
// counting what other processes wrote there before this one first wrote that
// day, this process writes nothing more to it, and says so once, on `warn`
// and on `log`. It writes again on the next UTC day.

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

import { TELEMETRY_RETENTION } from "./retention.ts";

export type TelemetryProcess = "daemon" | "cli";

export type FileTelemetryOptions = {
  // The folder the day folders go in.
  readonly dir: string;
  readonly process: TelemetryProcess;
  // Where the one warning about a failed write goes; stderr by default.
  readonly warn?: (line: string) => void;
  // How many bytes a day's folder may hold before this process stops writing
  // to it: TELEMETRY_RETENTION's cap by default.
  readonly maxBytesPerDay?: number;
  // Where the process says, too, that it stopped writing a day, such as the
  // daemon's daemon.log; nowhere else by default.
  readonly log?: (line: string) => Effect.Effect<void>;
};

type SpanStatus = "ok" | "error" | "unfinished";

// A record waiting to be written, with the UTC day it was written on.
type Pending = { readonly day: string; readonly line: string };

const FLUSH_EVERY = "1 second";

const NANOS_PER_MILLI = BigInt(1_000_000);

const dateOfNanos = (nanos: bigint) => new Date(Number(nanos / NANOS_PER_MILLI));

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

const MEGABYTE = 1024 * 1024;

// What a day's lines take on disk, as they are appended.
const bytesOf = (lines: ReadonlyArray<string>) =>
  lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);

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
    const maxBytesPerDay = options.maxBytesPerDay ?? TELEMETRY_RETENTION.maxBytes;
    const sayInLog = options.log ?? (() => Effect.void);
    const fileName = `${options.process}-${process.pid}.jsonl`;
    const writing = yield* Semaphore.make(1);

    const pending: Array<Pending> = [];
    const open = new Set<RecordedSpan>();
    let warned = false;
    // What each day's folder holds, as far as this process knows: what was
    // there when it first wrote the day, then what it wrote since.
    const heldOn = new Map<string, number>();
    // The days this process stopped writing.
    const capped = new Set<string>();

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

    // What the day's folder holds now, for a day this process hasn't written yet.
    const heldBefore = (folder: string) =>
      Effect.gen(function* () {
        let bytes = 0;

        for (const entry of yield* fs.readDirectory(folder)) {
          const info = yield* fs.stat(`${folder}/${entry}`);

          if (info.type === "File") {
            bytes += Number(info.size);
          }
        }

        return bytes;
      }).pipe(Effect.orElseSucceed(() => 0));

    // Stops writing the day for good, and says so once.
    const cap = (day: string, folder: string, held: number) =>
      Effect.suspend(() => {
        capped.add(day);
        const line = `telemetry: ${folder} holds ${Math.round(held / MEGABYTE)} MB, past the ${Math.round(maxBytesPerDay / MEGABYTE)} MB a day may hold; this ${options.process} (pid ${process.pid}) writes no more telemetry until the next UTC day`;
        warn(`chernabog: ${line}`);

        return sayInLog(line);
      });

    const writeDay = (day: string, lines: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const folder = `${options.dir}/${day}`;
        const file = `${folder}/${fileName}`;

        if (capped.has(day)) {
          return;
        }

        const held = heldOn.get(day) ?? (yield* heldBefore(folder));
        const bytes = bytesOf(lines);

        if (held + bytes > maxBytesPerDay) {
          return yield* cap(day, folder, held + bytes);
        }

        yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 }).pipe(
          Effect.andThen(
            fs.writeFileString(file, `${lines.join("\n")}\n`, { flag: "a", mode: 0o600 }),
          ),
          Effect.tap(
            Effect.sync(() => {
              heldOn.set(day, held + bytes);
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              warnOnce(
                `chernabog: telemetry couldn't be written to ${file}, and is being dropped: ${Cause.pretty(cause)}`,
              );
            }),
          ),
        );
      });

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
              writeDay(
                day,
                records.map((record) => record.line),
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
