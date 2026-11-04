// GET /runs/:id/log: a run's log as a text/event-stream, which the dashboard's
// page of the run shows. Each piece the log gains is one event, a `data:`
// line per line of it; once the run has finished, the last piece, then an
// `end` event, and the stream closes. A run the daemon has none of ends at
// once. A comment every 15 seconds keeps a quiet stream (a parked run's) open
// through the dashboard's listener.
//
// With `?step=<full step name>` (`implement#task-12`), only that step's lines,
// in the same events, ending the same way. How the log splits by step is the
// run's history's stepLogs: by the steps its lines are tagged with; for a log
// from before tags, the lines from `step: <name>` to the next `step:` line,
// unless the run declared lanes, when nothing but `end` is sent.

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { type StepLogs } from "../../../../kernel/run-log-line.value-object.ts";
import { type FoundRun } from "../../domain/run/run-view.value-object.ts";
import { type LogOfStep } from "../../queries/follow-run-log.query.ts";
import { type RunLogsQueries, RunsQueries } from "../../runs.query-handlers.ts";
import { followLog } from "../cli/run-log.output.ts";

const RunPath = Schema.Struct({ id: RunId });

const StepQuery = Schema.Struct({ step: Schema.optionalKey(Schema.String) });

// How often the daemon looks again at whether the run has finished.
const FINISHED_EVERY = "1 second";

const PING_EVERY = Duration.seconds(15);

const PING = ": ping\n\n";

const END = "event: end\ndata: \n\n";

// An event stream's lines end at a CR as well as at an LF, so a log's CR
// (a progress bar's) ends a line here too.
const logFrame = (text: string) =>
  `${text
    .split(/\r\n|\r|\n/)
    .map((line) => `data: ${line}\n`)
    .join("")}\n`;

const isRunning = (found: FoundRun) => Option.exists(found.run, (run) => run.status === "running");

export const followRunLogEndpoint = Effect.gen(function* () {
  const { id } = yield* HttpRouter.schemaPathParams(RunPath);
  const { step } = yield* HttpServerRequest.schemaSearchParams(StepQuery);
  const runs = yield* RunsQueries;

  // One step's lines, split as the run's history says its log splits.
  const only = yield* Option.match(Option.fromUndefinedOr(step), {
    onNone: () => Effect.succeed(Option.none<typeof LogOfStep.Type>()),
    onSome: (name) =>
      runs.ReadRunHistoryQuery({ runId: id }).pipe(
        Effect.map((history) =>
          Option.some({
            name,
            logs: Option.getOrElse(
              Option.fromUndefinedOr(history.stepLogs),
              (): StepLogs => "unavailable",
            ),
          }),
        ),
      ),
  });

  const context = yield* Effect.context<RunLogsQueries>();

  const finished = runs
    .FindRunQuery({ runId: id })
    .pipe(Effect.repeat({ schedule: Schedule.spaced(FINISHED_EVERY), while: isRunning }));

  const log = yield* followLog(id, finished, only).pipe(Effect.provideContext(context));

  const pings = Stream.tick(PING_EVERY).pipe(
    Stream.drop(1),
    Stream.map(() => PING),
  );

  // A read that fails ends the stream without `end`, so the page connects again.
  const frames = log.pipe(
    Stream.map(logFrame),
    Stream.concat(Stream.make(END)),
    Stream.catchCause(() => Stream.empty),
    Stream.merge(pings, { haltStrategy: "left" }),
    Stream.encodeText,
  );

  return HttpServerResponse.stream(frames, {
    contentType: "text/event-stream",
    headers: { "cache-control": "no-cache" },
  });
});
