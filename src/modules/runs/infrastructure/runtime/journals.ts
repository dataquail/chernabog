// A run's journal is a file of its own (ADR 23, decision 3): the workflow
// engine's tables for that run alone, in `journals/<run id>.db` under the
// chernabog home, created when the run executes and deleted when it ends.
// state.db keeps the machine's own records and holds no engine tables.
//
// The one WorkflowEngine a process provides routes each execution to an
// engine of its own: a cluster engine over a single runner over that run's
// journal. A spoke, and a process that is its own hub, executes one run and
// gets exactly one; a test's engine may hold several. A spoke also writes its reports here (`spoke_reports`):
// each record of its run that state.db keeps, which the hub tails and folds
// into state.db as the only writer there, and last how its run ended,
// which the hub reads once the spoke has exited.

import { SqliteClient } from "@effect/sql-sqlite-bun";
import * as ClusterWorkflowEngine from "effect/cluster/ClusterWorkflowEngine";
import * as SingleRunner from "effect/cluster/SingleRunner";
import * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";

import { homePaths } from "../../../../platform/home.ts";
import { SpokeEnding } from "../../domain/run/spoke-ending.value-object.ts";
import { SpokeReport } from "../../domain/run/spoke-report.value-object.ts";

// The files SQLite keeps for one journal: the database, and beside it while
// it's open its write-ahead log and shared memory, or, outside WAL mode, its
// rollback journal.
const SQLITE_SIDECARS = ["", "-wal", "-shm", "-journal"];

const JOURNAL = ".db";

// `spoke_reports` (ADR 23, decision 3): an append-only table of what a run's
// spoke tells the machine, each report its tag and its payload as JSON, in
// the order it was written: the runs' commands its run would have dispatched
// against state.db, by their tags, which the hub folds there, and
// last how its run ended (`RunEnded`), which the hub reads apart.
const SPOKE_REPORTS = `CREATE TABLE IF NOT EXISTS spoke_reports (
  seq INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  tag TEXT NOT NULL,
  payload TEXT NOT NULL
)`;

const RUN_ENDED = "RunEnded";

const EndedPayload = Schema.fromJsonString(SpokeEnding);
const encodeEnded = Schema.encodeSync(EndedPayload);
const decodeEnded = Schema.decodeUnknownOption(EndedPayload);

const PayloadRows = Schema.Array(Schema.Struct({ payload: Schema.String }));

const ReportRows = Schema.Array(SpokeReport);

const decodeReports = Schema.decodeUnknownEffect(ReportRows);

// `use` over its own connection to a journal, closed after.
const inJournal = <A, E>(
  filename: string,
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Layer.build(SqliteClient.layer({ filename })).pipe(
      Effect.flatMap((built) => use(Context.get(built, SqlClient.SqlClient))),
    ),
  );

// The run a payload is for: every flow's payload names it (FlowPayload).
const RunOfPayload = Schema.Struct({ runId: Schema.String });
const runOfPayload = Schema.decodeUnknownSync(RunOfPayload);

// The journals of this process's runs.
export class RunJournals extends Context.Service<
  RunJournals,
  {
    // Lets go of a run's journal: its execution is interrupted and its engine
    // closed, and only then are its files deleted, so nothing is still
    // writing one that's gone. Nothing for a run with none.
    readonly discard: (runId: string) => Effect.Effect<void>;
    // The runs that have a journal on this machine.
    readonly list: Effect.Effect<ReadonlyArray<string>>;
    // Whether this process has the run's journal open: whether its workflow
    // executes here rather than in a spoke.
    readonly isOpen: (runId: string) => Effect.Effect<boolean>;
    // Appends the spoke's last report to its run's journal: how the run
    // ended. Nothing for a run whose journal is gone.
    readonly reportEnded: (runId: string, ending: SpokeEnding) => Effect.Effect<void>;
    // The last ending a run's spoke reported in its journal; none for a run
    // with no journal, or a spoke that exited before it said. Reading makes
    // no journal.
    readonly reportedEnding: (runId: string) => Effect.Effect<Option.Option<SpokeEnding>>;
    // Appends a report to the run's journal, a runs' command by its tag and
    // its payload encoded as JSON, in order after those before it. Nothing
    // for a run whose journal is gone.
    readonly append: (runId: string, tag: string, payload: string) => Effect.Effect<void>;
    // The reports in the run's journal after `after`, in order, `RunEnded`
    // among them; none for a run with no journal. Reading makes no journal,
    // and writes nothing to one.
    readonly reports: (runId: string, after: number) => Effect.Effect<ReadonlyArray<SpokeReport>>;
  }
>()("RunJournals") {}

type Engine = WorkflowEngine.WorkflowEngine["Service"];

// A flow's workflow as the process registered it, registering it again in a
// run's engine for as long as `scope` lasts, with what its body needs.
type Registration = (engine: Engine, scope: Scope.Scope) => Effect.Effect<void>;

// One run's engine, open over its journal until the run ends or the process stops.
type Opened = {
  readonly engine: Engine;
  // The run's own connection to its journal for its reports, apart from the
  // engine's, so a report is never part of a transaction of the engine's.
  readonly reports: SqlClient.SqlClient;
  readonly scope: Scope.Closeable;
  readonly executions: Set<string>;
};

// How long closing a run's engine waits for what still runs in it before
// interrupting it. A journal is discarded only once its run has ended, so
// nothing in it has work left to finish; the cluster's default, 15 seconds,
// would only hold up the run's ending.
const TERMINATION = Duration.seconds(1);

// How often a run's engine reads its journal for messages that came due,
// such as a durable clock's: the cluster's own default unless a test, which
// can't wait that long for a clock, says otherwise.
export type EngineOptions = { readonly messagePoll?: Duration.Input };

// The engine over one journal. Its runner keeps nothing of its own: the
// journal is the run's alone, and no other process reads it.
const engineOver = (filename: string, options: EngineOptions) =>
  ClusterWorkflowEngine.layer.pipe(
    Layer.provideMerge(
      SingleRunner.layer({
        runnerStorage: "memory",
        shardingConfig: {
          entityTerminationTimeout: TERMINATION,
          ...Option.match(Option.fromUndefinedOr(options.messagePoll), {
            onNone: () => ({}),
            onSome: (every) => ({ entityMessagePollInterval: every }),
          }),
        },
      }),
    ),
    Layer.provide(SqliteClient.layer({ filename })),
  );

const journalsMade = (root: string, engineOptions: EngineOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = homePaths(root);
    const scope = yield* Effect.scope;
    // What building a run's engine needs from the process.
    const platform = yield* Effect.context<Crypto.Crypto>();
    const lock = yield* Semaphore.make(1);

    const registrations = new Map<string, Registration>();
    const opened = new Map<string, Opened>();
    const runOf = new Map<string, string>();

    yield* fs.makeDirectory(paths.journals, { recursive: true }).pipe(Effect.orDie);

    const registrationOf = (workflow: Workflow.Any) =>
      Option.match(Option.fromUndefinedOr(registrations.get(workflow._tag)), {
        onNone: () => Effect.die(`workflow ${workflow._tag} isn't registered in this process`),
        onSome: Effect.succeed,
      });

    // The run's engine, opened over its journal (made if there's none), with
    // the run's workflow registered in it.
    const openEngine = (workflow: Workflow.Any, runId: string) =>
      Effect.gen(function* () {
        const found = opened.get(runId);

        if (Predicate.isNotUndefined(found)) {
          return found;
        }

        const registration = yield* registrationOf(workflow);
        const own = yield* Scope.fork(scope, "sequential");

        const built = yield* Layer.buildWithScope(
          engineOver(paths.journal(runId), engineOptions),
          own,
        ).pipe(Effect.provideContext(platform), Effect.orDie);

        const engine = Context.get(built, WorkflowEngine.WorkflowEngine);

        const reports = Context.get(
          yield* Layer.buildWithScope(
            SqliteClient.layer({ filename: paths.journal(runId) }),
            own,
          ).pipe(Effect.orDie),
          SqlClient.SqlClient,
        );

        yield* reports.unsafe(SPOKE_REPORTS).pipe(Effect.orDie);

        yield* registration(engine, own);

        const made: Opened = { engine, reports, scope: own, executions: new Set() };
        opened.set(runId, made);

        return made;
      });

    const track = (made: Opened, runId: string, executionId: string) => {
      made.executions.add(executionId);
      runOf.set(executionId, runId);
    };

    // The engine an execution runs in, if its journal is open here.
    const engineOf = (executionId: string) =>
      Option.flatMap(Option.fromUndefinedOr(runOf.get(executionId)), (runId) =>
        Option.fromUndefinedOr(opened.get(runId)),
      );

    // `use` on the execution's engine, or `otherwise` when it has none here.
    const routed = <A, E, R>(
      executionId: string,
      use: (engine: Opened["engine"]) => Effect.Effect<A, E, R>,
      otherwise: Effect.Effect<A, E, R>,
    ) =>
      Option.match(engineOf(executionId), {
        onNone: () => otherwise,
        onSome: (found) => use(found.engine),
      });

    // Inside a workflow: the engine of the execution it is.
    const current = WorkflowEngine.WorkflowInstance.use((instance) =>
      Option.match(engineOf(instance.executionId), {
        onNone: () => Effect.die(`execution ${instance.executionId} has no journal open here`),
        onSome: (found) => Effect.succeed(found.engine),
      }),
    );

    const removeFiles = (runId: string) =>
      Effect.forEach(
        SQLITE_SIDECARS,
        (suffix) => fs.remove(`${paths.journal(runId)}${suffix}`, { force: true }),
        { discard: true },
      ).pipe(Effect.orDie);

    const journals = RunJournals.of({
      // The run's engine leaves the maps under the lock, so no new call
      // reaches it; it closes outside the lock, so another run's start never
      // waits on it.
      discard: (runId) =>
        Effect.gen(function* () {
          const found = yield* Effect.sync(() => {
            const one = Option.fromUndefinedOr(opened.get(runId));

            for (const gone of Option.toArray(one)) {
              opened.delete(runId);

              for (const executionId of gone.executions) {
                runOf.delete(executionId);
              }
            }

            return one;
          }).pipe(lock.withPermits(1));

          // Closing the engine's scope interrupts what still runs in it and
          // closes the journal's connection, before its files go.
          for (const gone of Option.toArray(found)) {
            yield* Scope.close(gone.scope, Exit.void);
          }

          yield* removeFiles(runId);
        }),
      // A journal the hub already deleted, as when it ended the run first, is
      // never made again by a late report.
      isOpen: (runId) => Effect.sync(() => opened.has(runId)),
      reportEnded: (runId, ending) =>
        Effect.gen(function* () {
          if (!(yield* fs.exists(paths.journal(runId)))) {
            return;
          }

          const at = DateTime.formatIso(yield* DateTime.now);

          yield* inJournal(paths.journal(runId), (sql) =>
            Effect.gen(function* () {
              yield* sql.unsafe(SPOKE_REPORTS);
              yield* sql`INSERT INTO spoke_reports (at, tag, payload)
                VALUES (${at}, ${RUN_ENDED}, ${encodeEnded(ending)})`;
            }),
          );
        }).pipe(Effect.orDie),
      reportedEnding: (runId) =>
        Effect.gen(function* () {
          if (!(yield* fs.exists(paths.journal(runId)))) {
            return Option.none<SpokeEnding>();
          }

          const rows = yield* inJournal(paths.journal(runId), (sql) =>
            Effect.gen(function* () {
              yield* sql.unsafe(SPOKE_REPORTS);

              return yield* sql`SELECT payload FROM spoke_reports
                WHERE tag = ${RUN_ENDED} ORDER BY seq DESC LIMIT 1`;
            }),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PayloadRows)));

          return Option.flatMap(Option.fromUndefinedOr(rows[0]), (row) => decodeEnded(row.payload));
        }).pipe(Effect.orDie),
      append: (runId, tag, payload) =>
        Effect.gen(function* () {
          const at = DateTime.formatIso(yield* DateTime.now);

          const insert = (sql: SqlClient.SqlClient) =>
            Effect.gen(function* () {
              yield* sql.unsafe(SPOKE_REPORTS);
              yield* sql`INSERT INTO spoke_reports (at, tag, payload)
                VALUES (${at}, ${tag}, ${payload})`;
            });

          const found = Option.fromUndefinedOr(opened.get(runId));

          if (Option.isSome(found)) {
            return yield* insert(found.value.reports);
          }

          if (yield* fs.exists(paths.journal(runId))) {
            yield* inJournal(paths.journal(runId), insert);
          }
        }).pipe(Effect.orDie),
      reports: (runId, after) =>
        Effect.gen(function* () {
          if (!(yield* fs.exists(paths.journal(runId)))) {
            return [];
          }

          const read = (sql: SqlClient.SqlClient) =>
            Effect.gen(function* () {
              const tables = yield* sql`SELECT name FROM sqlite_master
                WHERE type = 'table' AND name = 'spoke_reports'`;

              if (tables.length === 0) {
                return [];
              }

              return yield* sql`SELECT seq, at, tag, payload FROM spoke_reports
                WHERE seq > ${after} ORDER BY seq`.pipe(Effect.flatMap(decodeReports));
            });

          // The process that writes the journal reads it over its own
          // connection; any other opens one for the read.
          return yield* Option.match(Option.fromUndefinedOr(opened.get(runId)), {
            onSome: (found) => read(found.reports),
            onNone: () => inJournal(paths.journal(runId), read),
          });
        }).pipe(Effect.orDie),
      list: fs.readDirectory(paths.journals).pipe(
        Effect.map((names) =>
          names
            .filter((name) => name.endsWith(JOURNAL))
            .map((name) => name.slice(0, -JOURNAL.length)),
        ),
        Effect.orDie,
      ),
    });

    const router = WorkflowEngine.WorkflowEngine.of({
      // Kept to register again in each run's engine, with the context it was
      // registered in: what the workflow's body needs.
      register: (workflow, execute) => {
        const registering = (inner: Engine) => inner.register(workflow, execute);

        return Effect.map(
          Effect.context<Effect.Services<ReturnType<typeof registering>>>(),
          (context) => {
            registrations.set(workflow._tag, (inner, own) =>
              registering(inner).pipe(
                Effect.provideContext(Context.add(context, Scope.Scope, own)),
              ),
            );
          },
        );
      },
      execute: (workflow, options) =>
        Effect.gen(function* () {
          const runId = runOfPayload(options.payload).runId;
          const made = yield* openEngine(workflow, runId).pipe(lock.withPermits(1));
          track(made, runId, options.executionId);

          return yield* made.engine.execute(workflow, options);
        }),
      poll: (workflow, executionId) =>
        routed(executionId, (found) => found.poll(workflow, executionId), Effect.succeedNone),
      interrupt: (workflow, executionId) =>
        routed(executionId, (found) => found.interrupt(workflow, executionId), Effect.void),
      interruptUnsafe: (workflow, executionId) =>
        routed(executionId, (found) => found.interruptUnsafe(workflow, executionId), Effect.void),
      resume: (workflow, executionId) =>
        routed(executionId, (found) => found.resume(workflow, executionId), Effect.void),
      activityExecute: (activity, attempt) =>
        Effect.flatMap(current, (found) => found.activityExecute(activity, attempt)),
      deferredResult: (deferred) =>
        Effect.flatMap(current, (found) => found.deferredResult(deferred)),
      // A deferred done for a run whose journal isn't open here wakes nothing:
      // the run has ended, or runs elsewhere.
      deferredDone: (deferred, options) =>
        routed(options.executionId, (found) => found.deferredDone(deferred, options), Effect.void),
      scheduleClock: (workflow, options) =>
        routed(options.executionId, (found) => found.scheduleClock(workflow, options), Effect.void),
    });

    return Context.make(RunJournals, journals).pipe(
      Context.add(WorkflowEngine.WorkflowEngine, router),
    );
  });

// The workflow engine over a journal per run, in `journals/` under `root`.
export const JournalsAt = (root: string, options: EngineOptions = {}) =>
  Layer.effectContext(journalsMade(root, options));
