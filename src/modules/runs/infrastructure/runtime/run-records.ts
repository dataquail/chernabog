// Where a run's workflow keeps what the machine records of it: its steps,
// lanes, plan nodes, subjects, markers, created issues, plan, usage, park and
// the agent sessions it opened,
// and what it reads back of them within itself.
//
// A process that is its own hub (the foreground `run`, `rehearse`, `ci run`
// under Actions) dispatches each record on the runs' commands at once, into
// its state.db. A spoke never writes state.db (ADR 23, decision 3): it
// appends each record to its run's journal, `spoke_reports`, as the runs'
// command it would have dispatched, encoded with that command's own schema,
// and the hub tails the journal and folds the records into state.db
// (decision 8). What a spoke reads back (the markers it holds, a session's
// token cursor) it reads from its own reports, and its run's record from what
// its hub handed it.

import { SqliteClient } from "@effect/sql-sqlite-bun";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { type RunId } from "../../../../kernel/run-id.id.ts";
import {
  AGENT_SESSION_OPENED,
  type AgentSessionOpened,
  encodeSessionOpened,
} from "../../domain/run/agent-session-opened.value-object.ts";
import { type RunView } from "../../domain/run/run-view.value-object.ts";
import { type SpokeHandOver } from "../../domain/run/spoke-hand-over.value-object.ts";
import { type SpokeReport } from "../../domain/run/spoke-report.value-object.ts";
import {
  decodeSpokeReport,
  encodeSpokeReport,
  type RunsCommands,
  SpokeReportCommand,
} from "../../runs.command-handlers.ts";
import type { RunsQueries } from "../../runs.query-handlers.ts";
import { RunJournals } from "./journals.ts";

// What the runs' command of that name takes.
type PayloadOf<K extends keyof RunsCommands["Service"]> = Parameters<RunsCommands["Service"][K]>[0];

const {
  DeclareLaneCommand,
  EnterStepCommand,
  FinishStepCommand,
  ForgetMarkerCommand,
  HoldMarkerCommand,
  NameSubjectCommand,
  ParkRunCommand,
  RecordCreatedIssueCommand,
  RecordNodeCommand,
  RecordTokenUsageCommand,
  SaveRunPlanCommand,
} = SpokeReportCommand;

// A marker's arguments as one line of JSON, which tells two holds of a name
// apart, as the runs' markers do.
const argsText = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

export type RunRecordsService = {
  // The run as the machine recorded it when it started: its core, persona
  // and tree. None for a run it has no record of.
  readonly run: (runId: RunId) => Effect.Effect<Option.Option<RunView>>;
  readonly enterStep: (entering: PayloadOf<"EnterStepCommand">) => Effect.Effect<void>;
  readonly finishStep: (finishing: PayloadOf<"FinishStepCommand">) => Effect.Effect<void>;
  readonly declareLane: (lane: PayloadOf<"DeclareLaneCommand">) => Effect.Effect<void>;
  readonly nameSubject: (subject: PayloadOf<"NameSubjectCommand">) => Effect.Effect<void>;
  readonly holdMarker: (holding: PayloadOf<"HoldMarkerCommand">) => Effect.Effect<void>;
  readonly forgetMarker: (forgetting: PayloadOf<"ForgetMarkerCommand">) => Effect.Effect<void>;
  readonly recordCreatedIssue: (
    created: PayloadOf<"RecordCreatedIssueCommand">,
  ) => Effect.Effect<void>;
  readonly recordNode: (node: PayloadOf<"RecordNodeCommand">) => Effect.Effect<void>;
  readonly saveRunPlan: (plan: PayloadOf<"SaveRunPlanCommand">) => Effect.Effect<void>;
  readonly recordTokenUsage: (call: PayloadOf<"RecordTokenUsageCommand">) => Effect.Effect<void>;
  readonly parkRun: (parking: PayloadOf<"ParkRunCommand">) => Effect.Effect<void>;
  // That one of the run's agent calls started or resumed a session: what a
  // spoke reports, so its hub can close the session by its launcher's handle
  // (ADR 23, decision 5). A process that is its own hub records nothing: the
  // session is in the run's session files, where cancel finds it.
  readonly openedSession: (runId: RunId, opened: AgentSessionOpened) => Effect.Effect<void>;
  // The arguments of the markers named `name` the run holds.
  readonly held: (runId: RunId, name: string) => Effect.Effect<ReadonlyArray<Schema.Json>>;
  // How far a session's token usage has been read; none for one never read.
  readonly cursor: (adapter: string, sessionId: string) => Effect.Effect<Option.Option<string>>;
};

// A spoke provides it, over its journal (`RunRecordsInJournal`); without it,
// the engine dispatches a run's records on the runs' commands
// (`dispatchingRecords`).
export class RunRecords extends Context.Service<RunRecords, RunRecordsService>()(
  "chernabog/RunRecords",
) {}

// A step, subject or anything else reported after its run ended changes
// nothing: the commands that refuse one refuse it here too, and that is all.
const quietly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.ignore({ log: false }));

// Each record dispatched on the runs' commands at once, into this process's
// state.db, and read back from there: a process that is its own hub.
export const dispatchingRecords = (
  commands: RunsCommands["Service"],
  queries: RunsQueries["Service"],
): RunRecordsService => ({
  run: (runId) => queries.FindRunQuery({ runId }).pipe(Effect.map((found) => found.run)),
  enterStep: (entering) => quietly(commands.EnterStepCommand(entering)),
  finishStep: (finishing) => commands.FinishStepCommand(finishing),
  declareLane: (lane) => commands.DeclareLaneCommand(lane),
  nameSubject: (subject) => quietly(commands.NameSubjectCommand(subject)),
  holdMarker: (holding) => commands.HoldMarkerCommand(holding).pipe(Effect.asVoid),
  forgetMarker: (forgetting) => commands.ForgetMarkerCommand(forgetting),
  recordCreatedIssue: (created) => commands.RecordCreatedIssueCommand(created),
  recordNode: (node) => commands.RecordNodeCommand(node),
  saveRunPlan: (plan) => commands.SaveRunPlanCommand(plan),
  recordTokenUsage: (call) => commands.RecordTokenUsageCommand(call),
  parkRun: (parking) => commands.ParkRunCommand(parking).pipe(Effect.asVoid),
  openedSession: () => Effect.void,
  held: (runId, name) =>
    queries
      .ListRunMarkersQuery({ runId, name: Option.some(name) })
      .pipe(Effect.map((found) => found.markers.map((marker) => marker.args))),
  cursor: (adapter, sessionId) =>
    queries
      .ReadTokenUsageCursorQuery({ adapter, sessionId })
      .pipe(Effect.map((found) => found.cursor)),
});

// The arguments of the markers named `name` a run's reports leave it holding:
// each hold, less those forgotten after it, in the order it held them.
export const heldIn = (reports: ReadonlyArray<SpokeReport>, name: string) => {
  const held = new Map<string, Schema.Json>();

  for (const report of reports) {
    for (const holding of Option.toArray(decodeSpokeReport(HoldMarkerCommand, report))) {
      if (holding.name === name) {
        held.set(argsText(holding.args), holding.args);
      }
    }

    for (const forgetting of Option.toArray(decodeSpokeReport(ForgetMarkerCommand, report))) {
      if (forgetting.name === name) {
        held.delete(argsText(forgetting.args));
      }
    }
  }

  return [...held.values()];
};

// How far a run's own reports read a session's token usage: its last reading.
export const cursorIn = (reports: ReadonlyArray<SpokeReport>, adapter: string, sessionId: string) =>
  reports
    .flatMap((report) => Option.toArray(decodeSpokeReport(RecordTokenUsageCommand, report)))
    .filter((call) => call.adapter === adapter && call.sessionId === sessionId)
    .reduce<Option.Option<string>>(
      (cursor, call) =>
        Option.orElse(
          Option.map(call.reading, (reading) => reading.cursor),
          () => cursor,
        ),
      Option.none(),
    );

const decodeCursor = Schema.decodeUnknownOption(Schema.Struct({ cursor: Schema.String }));

// The one read a spoke makes of state.db, where ADR 23's decision 3 has it
// make none: how far an earlier run read a session's token usage, which no hub
// can hand over, since which session a call uses is known only when the flow
// makes it. Opened read-only and query-only, on the first cursor its own
// reports don't have, and closed with the spoke. A state.db that's missing,
// locked or older than the table reads as a session never read.
const stateCursors = (database: string) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    let opened = Option.none<SqlClient.SqlClient>();

    // The connection, opened the first time it's asked for.
    const open = () =>
      Option.match(opened, {
        onSome: Effect.succeed,
        onNone: () =>
          Layer.buildWithScope(
            SqliteClient.layer({ filename: database, readonly: true }),
            scope,
          ).pipe(
            Effect.map((built) => Context.get(built, SqlClient.SqlClient)),
            Effect.tap((sql) => sql.unsafe("PRAGMA query_only = ON")),
            Effect.tap((sql) =>
              Effect.sync(() => {
                opened = Option.some(sql);
              }),
            ),
          ),
      });

    return (adapter: string, sessionId: string) =>
      Effect.suspend(open).pipe(
        Effect.flatMap(
          (sql) =>
            sql`SELECT cursor FROM om_usage_cursors
              WHERE adapter = ${adapter} AND session_id = ${sessionId}`,
        ),
        Effect.map((rows) =>
          Option.flatMap(Arr.head(rows), (row) =>
            Option.map(decodeCursor(row), (found) => found.cursor),
          ),
        ),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
  });

// A spoke's records, in its run's journal; its run's record is what its hub
// handed it, and state.db is read only for a token cursor its own reports
// don't have.
export const RunRecordsInJournal = (handOver: SpokeHandOver, database: string) =>
  Layer.effect(
    RunRecords,
    Effect.gen(function* () {
      const journals = yield* RunJournals;
      const fromState = yield* stateCursors(database);

      const append =
        <M extends Parameters<typeof encodeSpokeReport>[0]>(command: M) =>
        (payload: Parameters<typeof encodeSpokeReport<M>>[1] & { readonly runId: RunId }) =>
          journals.append(payload.runId, command.tag, encodeSpokeReport(command, payload));

      // A step's own time, since the hub folds it later.
      const stamped = <P>(payload: P) =>
        Effect.map(DateTime.now, (now) => ({ ...payload, at: DateTime.formatIso(now) }));

      const reportsOf = (runId: RunId) => journals.reports(runId, 0);

      return RunRecords.of({
        run: (runId) =>
          Effect.succeed(Option.liftPredicate(handOver.run, (run) => run.id === runId)),
        enterStep: (entering) => Effect.flatMap(stamped(entering), append(EnterStepCommand)),
        finishStep: (finishing) => Effect.flatMap(stamped(finishing), append(FinishStepCommand)),
        declareLane: append(DeclareLaneCommand),
        nameSubject: append(NameSubjectCommand),
        holdMarker: append(HoldMarkerCommand),
        forgetMarker: append(ForgetMarkerCommand),
        recordCreatedIssue: append(RecordCreatedIssueCommand),
        recordNode: append(RecordNodeCommand),
        saveRunPlan: append(SaveRunPlanCommand),
        recordTokenUsage: append(RecordTokenUsageCommand),
        parkRun: append(ParkRunCommand),
        openedSession: (runId, opened) =>
          journals.append(runId, AGENT_SESSION_OPENED, encodeSessionOpened(opened)),
        held: (runId, name) => Effect.map(reportsOf(runId), (reports) => heldIn(reports, name)),
        cursor: (adapter, sessionId) =>
          Effect.flatMap(reportsOf(handOver.run.id), (reports) =>
            Option.match(cursorIn(reports, adapter, sessionId), {
              onNone: () => fromState(adapter, sessionId),
              onSome: Effect.succeedSome,
            }),
          ),
      });
    }),
  );
