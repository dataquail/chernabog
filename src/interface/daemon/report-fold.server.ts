// How a hub folds a run's journal into state.db, and ends the run from what
// the journal said (ADR 23, decisions 2, 3 and 8). The daemon is the hub of
// the spokes it starts; the foreground `run`, `rehearse` and `ci run` under
// Actions are their own hub (decision 9), and fold their own journal the same
// way, so a run's records reach state.db by one path wherever it executes.

import { describeError } from "@chernabog/core";
import { type Command, CommandBus } from "@effect-server-utils/cqrs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { type RunId, shortRunId } from "../../kernel/run-id.id.ts";
import {
  type AgentSessionOpened,
  CancelTarget,
  RunFlowsCommands,
  runLogFor,
  RunsCommands,
  RunsQueries,
  sessionOpenedIn,
  type SpokeEnding,
  type SpokeReport,
  spokeReportCommands,
  spokeReportPayloadJson,
} from "../../modules/runs/runs.platform.ts";

// What folding a report does: dispatch one of the runs' commands with its
// payload, skip it saying why, keep an agent session the spoke opened on the
// live spoke, or nothing, for the spoke's ending, which the hub reads apart
// once the spoke has exited.
export type ReportFold = Data.TaggedEnum<{
  Dispatch: {
    readonly command: Command.Any;
    readonly payload: unknown;
  };
  Skip: { readonly why: string };
  Session: { readonly opened: AgentSessionOpened };
  Ending: Record<never, never>;
}>;

export const ReportFold = Data.taggedEnum<ReportFold>();

// A report as the runs' command it carries, decoded with that command's own
// schema; one the hub doesn't fold, or can't read, is skipped.
export const reportFold = (report: SpokeReport): ReportFold => {
  if (report.tag === "RunEnded") {
    return ReportFold.Ending();
  }

  if (report.tag === "AgentSessionOpened") {
    return Option.match(sessionOpenedIn(report), {
      onNone: () =>
        ReportFold.Skip({ why: `the hub skipped a ${report.tag} whose payload it couldn't read` }),
      onSome: (opened) => ReportFold.Session({ opened }),
    });
  }

  return Option.match(
    Option.fromUndefinedOr(spokeReportCommands.find((known) => known.tag === report.tag)),
    {
      onNone: () =>
        ReportFold.Skip({ why: `the hub skipped a report it doesn't fold: ${report.tag}` }),
      onSome: (command) =>
        Option.match(Schema.decodeOption(spokeReportPayloadJson(command))(report.payload), {
          onNone: () =>
            ReportFold.Skip({
              why: `the hub skipped a ${report.tag} whose payload it couldn't read`,
            }),
          onSome: (payload) => ReportFold.Dispatch({ command, payload }),
        }),
    },
  );
};

// Folds a run's reports after `folded` into state.db, in order. Each report
// and the position past it move together, uninterruptibly, so a tail stopped
// midway leaves no report folded that the next fold takes again.
export const foldSpoke = <R, S>(
  runId: RunId,
  folded: Ref.Ref<number>,
  reports: (runId: RunId, after: number) => Effect.Effect<ReadonlyArray<SpokeReport>, never, R>,
  apply: (runId: RunId, report: SpokeReport) => Effect.Effect<void, never, S>,
) =>
  Effect.gen(function* () {
    for (const report of yield* reports(runId, yield* Ref.get(folded))) {
      yield* Effect.uninterruptible(
        apply(runId, report).pipe(Effect.andThen(Ref.set(folded, report.seq))),
      );
    }
  });

// Folds one report into state.db and moves the fold position past it, in
// one unit of work (ADR 23, decision 3): the runs' commands each join it, so
// the report and the position commit together or not at all, and a report
// takes effect once however the hub stops.
export const foldInUnitOfWork = <E, R, F>(
  inOneUnitOfWork: (effect: Effect.Effect<void, E, R>) => Effect.Effect<void, F, R>,
  report: Effect.Effect<void, E, R>,
  advance: Effect.Effect<void, E, R>,
) => inOneUnitOfWork(Effect.andThen(report, advance));

// A line in a run's log, from its hub.
export const noteInRun = (runId: RunId, line: string) =>
  runLogFor(runId).pipe(
    Effect.flatMap((runLog) => runLog.log(line)),
    Effect.ignoreCause,
  );

// Folds one of a run's reports into state.db: the runs' command it carries,
// dispatched on the hub's bus, so what it records reaches status and /events
// as a dispatch in the hub would. A report the hub can't read or refuses is
// said in the run's log and skipped, never retried. The ending is read apart,
// and an agent session is the live spoke's, not state.db's.
export const foldReport = (runId: RunId, report: SpokeReport) =>
  ReportFold.$match(reportFold(report), {
    Ending: () => Effect.void,
    Session: () => Effect.void,
    Skip: ({ why }) => noteInRun(runId, why),
    Dispatch: ({ command, payload }) =>
      Effect.gen(function* () {
        const dispatched = yield* Effect.result((yield* CommandBus).execute(command, payload));

        if (Result.isFailure(dispatched)) {
          yield* noteInRun(
            runId,
            `the hub refused ${report.tag}: ${describeError(dispatched.failure)}`,
          );
        }
      }),
  }).pipe(
    Effect.catchCause((cause) =>
      noteInRun(runId, `the hub could not fold ${report.tag}: ${String(cause)}`),
    ),
  );

// Folds a report and moves the run's fold position past it in one state.db
// transaction, the runs' unit of work around both commands, each of which
// joins it: the report takes effect once whatever stops the hub, and a hub
// that starts folds from where this one left off (`om_spokes.folded_seq`). A
// report whose command is refused rolls back alone, and the position still
// moves past it.
export const foldInStateDb =
  (inOneUnitOfWork: OneUnitOfWork, log: (line: string) => Effect.Effect<void>) =>
  (runId: RunId, report: SpokeReport) =>
    RunsCommands.use((runs) =>
      foldInUnitOfWork(
        inOneUnitOfWork,
        foldReport(runId, report),
        runs.AdvanceSpokeFoldCommand({ runId, seq: report.seq }),
      ),
    ).pipe(
      Effect.catchCause((cause) =>
        log(`could not fold ${report.tag} of ${shortRunId(runId)}: ${String(cause)}`),
      ),
    );

// What runs an effect in one unit of work of the runs' (RunsModule.inOneUnitOfWork).
export type OneUnitOfWork = <A, F, S>(effect: Effect.Effect<A, F, S>) => Effect.Effect<A, never, S>;

// Ends a run that is still running with the ending its journal said, or
// `fallback` when it said none (ADR 23, decision 2): a park through cancel,
// which keeps its markers and lets go of its claim ref, anything else as a
// finish. A run something else ended first stays as it ended.
export const endAsSaid = (
  runId: RunId,
  said: Option.Option<SpokeEnding>,
  fallback: () => SpokeEnding,
) =>
  Effect.gen(function* () {
    const found = Option.filter(
      (yield* RunsQueries.use((runs) => runs.FindRunQuery({ runId }))).run,
      (run) => run.status === "running",
    );

    if (Option.isNone(found)) {
      return;
    }

    const { status, summary } = Option.getOrElse(said, fallback);

    if (status === "ended-at-park") {
      yield* RunFlowsCommands.use((runs) =>
        runs.CancelRunCommand({
          target: CancelTarget.cases.ById.make({ asked: runId }),
          by: "chernabog",
          closeSessions: false,
          endAs: Option.some({ ending: "ended-at-park", reason: summary }),
        }),
      );

      return;
    }

    yield* RunsCommands.use((runs) => runs.FinishRunCommand({ runId, status, summary }));
  });
