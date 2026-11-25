// A run in a process that is its own hub (ADR 23, decision 9): the foreground
// `run`, `rehearse` and `ci run` under Actions. It executes the run as a spoke
// does, in a journal of the run's own whose reports are its records, and
// folds that journal into its own state.db as the daemon folds a spoke's,
// then ends the run as the daemon ends a spoke's run. So the code a run
// executes is the same on a runner, in the foreground and under the daemon,
// and a park ends the run there too: no run waits inside a process.
//
// The process records itself as the run's spoke (`om_spokes`), with its fold
// position, so a hub that starts after it died ends the run as interrupted
// and folds what its journal holds from where it left off, and a foreground
// run that finds the run still running can tell whether a live process still
// owns it.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { type RunId, shortRunId } from "../../kernel/run-id.id.ts";
import {
  CancelTarget,
  type FlowRef,
  RunFlowsCommands,
  RunFlowsQueries,
  RunsCommands,
  RunsModule,
  RunsQueries,
  type RunView,
  SpokeEnding,
  type SpokeRecordView,
  type WorkItem,
} from "../../modules/runs/runs.platform.ts";
import { ConfigError } from "../../platform/config-error.ts";
import { processIdentity } from "../../platform/process-group.ts";
import { endAsSaid, foldInStateDb, foldSpoke } from "../daemon/report-fold.server.ts";
import { isSpoke } from "../daemon/spokes.server.ts";

// Why a run a foreground run takes over ends: the process it ran in stopped.
const INTERRUPTED_REASON =
  "the process it ran in stopped before it ended; its phase repeats in a new run";

// Why a run in this process ended at its park, as the daemon says it of a spoke's.
const PARKED_REASON =
  "it waits on a person or another system: its record carries the wait, and a later run takes it up";

// How a run in this process reached its boundary: its workflow ended, or it
// parked; or a stop of the caller's own, such as a CI job's time running out.
export type OwnBoundary<A> =
  | { readonly kind: "ended"; readonly status: string; readonly summary: string }
  | { readonly kind: "parked" }
  | { readonly kind: "stopped"; readonly stop: A };

// The ending a boundary says, for the run's record; none for a stop of the caller's.
export const endingAt = <A>(boundary: OwnBoundary<A>): Option.Option<SpokeEnding> => {
  switch (boundary.kind) {
    case "parked":
      return Option.some<SpokeEnding>({ status: "ended-at-park", summary: PARKED_REASON });
    case "ended":
      return Schema.decodeUnknownOption(SpokeEnding)({
        status: boundary.status,
        summary: boundary.summary,
      });
    case "stopped":
      return Option.none();
  }
};

// The process this one is, as ps says: what its spoke record keeps.
const self = Effect.map(processIdentity(process.pid), (found) =>
  Option.map(found, (identity) => identity.startedAt),
);

// Whether the process a spoke record names still owns its run: the same PID,
// started when the record says, or, when it says no start, a spoke's command
// line for that run. A PID another process has now owns nothing.
export const ownerAlive = (record: SpokeRecordView) =>
  Effect.map(processIdentity(record.pid), (found) =>
    Option.match(found, {
      onNone: () => false,
      onSome: (identity) =>
        Option.match(record.startedAt, {
          onSome: (startedAt) => startedAt === identity.startedAt,
          onNone: () =>
            isSpoke(
              {
                runId: record.runId,
                pid: record.pid,
                startedAt: record.startedAt,
                foldedSeq: record.foldedSeq,
                ending: Option.none(),
              },
              identity,
            ),
        }),
    }),
  );

// A run's own hub: folds its journal into state.db from `folded`, and ends it.
const hubOf = (runId: RunId, folded: Ref.Ref<number>) =>
  Effect.gen(function* () {
    const inOneUnitOfWork = yield* RunsModule.inOneUnitOfWork;
    const apply = foldInStateDb(inOneUnitOfWork, (line) => Effect.logWarning(line));

    const reports = (asked: RunId, after: number) =>
      RunFlowsQueries.use((runs) => runs.ReadSpokeReportsQuery({ runId: asked, after })).pipe(
        Effect.map((found) => found.reports),
        Effect.orElseSucceed(() => []),
      );

    const fold = foldSpoke(runId, folded, reports, apply);

    // Folds what's left, ends the run as `said` (failed when it said
    // nothing), and forgets its spoke record.
    const end = (said: Option.Option<SpokeEnding>, fallback: string) =>
      Effect.gen(function* () {
        yield* fold;
        yield* endAsSaid(runId, said, () => ({ status: "failed", summary: fallback }));
        yield* RunsCommands.use((runs) => runs.ForgetSpokeCommand({ runId }));
      }).pipe(Effect.orDie);

    return { fold, end };
  });

// Records a run of `flow` for `item` as a hub does, with its execution
// attached in one unit of work, records this process as its spoke, and
// executes it here, in a journal of its own. None when another run already
// has the item.
export const startOwnRun = (flow: FlowRef, item: WorkItem) =>
  Effect.gen(function* () {
    const outcome = yield* (yield* RunFlowsCommands)
      .StartSpokeRunCommand({ flow, item })
      .pipe(Effect.orDie);

    if (!outcome.started) {
      return Option.none<RunView>();
    }

    const run = yield* Effect.fromOption(outcome.run).pipe(Effect.orDie);
    const startedAt = yield* self;

    yield* (yield* RunsCommands)
      .RecordSpokeCommand({
        runId: run.id,
        pid: process.pid,
        startedAt,
        hubPid: process.pid,
        hubStartedAt: startedAt,
      })
      .pipe(Effect.orDie);

    yield* (yield* RunFlowsCommands)
      .ExecuteRunCommand({ run, item })
      .pipe(
        Effect.mapError(
          (error) => new ConfigError({ message: `executing ${run.id}: ${error.message}` }),
        ),
      );

    return Option.some(run);
  });

// Polls a run in this process, folding its journal into state.db before each
// look, until it reaches its boundary: its workflow ended, it parked
// (`parked` holds what this process's engine told it), or `stop` said to.
const untilBoundary = <A, E, R, P, F>(
  run: RunView,
  parked: ReadonlySet<RunId>,
  stop: Effect.Effect<Option.Option<A>, E, R>,
  onPoll: Effect.Effect<void, never, P>,
  fold: Effect.Effect<void, never, F>,
) =>
  Effect.gen(function* () {
    const executionId = yield* Effect.fromOption(run.executionId).pipe(Effect.orDie);
    const flow = { repo: run.repo, flow: run.flow, persona: run.persona };

    for (;;) {
      yield* fold;
      yield* onPoll;

      const polled = yield* RunFlowsQueries.use((runs) =>
        runs.PollExecutionQuery({ runId: run.id, executionId, flow }),
      ).pipe(Effect.orDie);

      for (const ended of Option.toArray(polled.ended)) {
        return {
          kind: "ended",
          status: ended.status,
          summary: ended.summary,
        } satisfies OwnBoundary<A>;
      }

      if (parked.has(run.id)) {
        return { kind: "parked" } satisfies OwnBoundary<A>;
      }

      for (const stopped of Option.toArray(yield* stop)) {
        return { kind: "stopped", stop: stopped } satisfies OwnBoundary<A>;
      }

      yield* Effect.sleep("1 second");
    }
  });

// Follows a run in this process to its boundary, folding its journal as it
// goes, then ends the run with what the boundary says; a stop of the
// caller's leaves it running, as a spoke stopped from outside leaves its run
// to its hub.
export const followOwnRun = <A, E, R, P = never>(
  run: RunView,
  parked: ReadonlySet<RunId>,
  stop: Effect.Effect<Option.Option<A>, E, R>,
  onPoll: Effect.Effect<void, never, P> = Effect.void,
) =>
  Effect.gen(function* () {
    const hub = yield* hubOf(run.id, yield* Ref.make(0));
    const boundary: OwnBoundary<A> = yield* untilBoundary(run, parked, stop, onPoll, hub.fold);
    const said = endingAt(boundary);

    if (Option.isSome(said)) {
      yield* hub.end(said, "it ended without saying how");
    } else {
      yield* hub.fold;
    }

    yield* onPoll;

    return boundary;
  });

// Ends a run this process found still running, which no process runs any
// more, as interrupted: what its journal holds is folded first, from where
// its record says, and its phase repeats in a new run. Refused while a live
// process still owns it (a spoke of the daemon's, or another foreground
// run), so two processes never run one run.
export const takeOverLeftRun = (run: { readonly id: RunId; readonly flow: string }) =>
  Effect.gen(function* () {
    const record = Option.fromUndefinedOr(
      (yield* (yield* RunsQueries).ListSpokesQuery({})).spokes.find(
        (spoke) => spoke.runId === run.id,
      ),
    );

    for (const owned of Option.toArray(record)) {
      if (yield* ownerAlive(owned)) {
        return yield* new ConfigError({
          message: `run ${shortRunId(run.id)} of ${run.flow} is still running in process ${owned.pid}; let it end, or cancel it with chernabog cancel ${shortRunId(run.id)}`,
        });
      }
    }

    const folded = yield* Ref.make(
      Option.match(record, { onNone: () => 0, onSome: (owned) => owned.foldedSeq }),
    );

    yield* (yield* hubOf(run.id, folded)).fold;

    // Its agent's sessions are closed: the run that owned them is dead, so
    // nobody watches them, and the new run would work beside them. A session
    // a person works in stays open.
    const ended = yield* (yield* RunFlowsCommands).CancelRunCommand({
      target: CancelTarget.cases.ById.make({ asked: run.id }),
      by: "chernabog",
      closeSessions: true,
      sparePersonSessions: true,
      endAs: Option.some({ ending: "interrupted", reason: INTERRUPTED_REASON }),
    });

    yield* (yield* RunsCommands).ForgetSpokeCommand({ runId: run.id });

    return ended;
  });
