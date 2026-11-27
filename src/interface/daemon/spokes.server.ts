// The hub's spokes (ADR 23): each run the daemon starts executes in a process
// of its own, the hub's own executable as `ci run --run`, leading a process
// group of its own, with a pipe on its stdin the hub holds for the spoke's
// whole life. The hub keeps each live spoke's handle here, by its run, until
// the spoke exits; then it ends the run from what the spoke reported.
//
// While a spoke lives, the hub tails its journal (ADR 23, decision 8): on a
// watch of the journals, with a poll behind it every 2 seconds, it folds each
// report the spoke appended since the last into state.db, in order, when the
// journal's files have changed since the last fold, and once
// the spoke has exited it folds what's left before it ends the run. Spokes
// push nothing: what the hub knows of a run in flight is what its spoke wrote
// to disk. The hub reads nothing of a spoke's stdout but log lines.
//
// A run the hub ends while its spoke lives (a cancel, a lost lease, an item
// that went) ends the spoke first, through `end` (ADR 23, decisions 5 and
// 6): the hub records the ending it means for the spoke, signals its group
// and waits for it to exit and for its last reports to be folded, and the
// command that asked then ends the run. The hub keeps the agent sessions a
// spoke reported opening, so that command can close them by their handles.
//
// The hub bounds every spoke (ADR 23, decision 4). Every 5 seconds it
// measures each live spoke: its telemetry and run-log bytes, how long it has
// run, how long since any of its files last grew (its journal, its run log,
// the transcripts of the agent sessions it reported) and its process group's
// resident memory. A spoke past a bound is handed to `onBound`, which
// ends its run failed, naming the bound, through `end`. The spoke caps its
// own telemetry and run log at their bounds too, which the hub passes it,
// and stops itself a margin after its phase-time bound, so the hub's bound
// is the one that ends it.
//
// Each spoke is recorded in state.db once spawned (`om_spokes`, ADR 23,
// decision 7): its PID and process group, when the OS says it started, how
// far its journal is folded, and the ending the hub means for it once it
// means one. Each report and the fold position past it commit together, so
// the next hub folds each report once. A hub that starts reaps the spokes of
// the hub before it (`reap`): ends one still running, once it has checked
// the PID is still that spoke's, folds what its journal holds, and answers
// for it as for a spoke it ended, so its run ends as the hub before meant it
// to, or as interrupted, and its phase repeats in a new run.

import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { type RunId, shortRunId } from "../../kernel/run-id.id.ts";
import {
  breachOf,
  type SpokeBounds,
  type SpokeBreach,
  type SpokeMeasure,
} from "../../kernel/spoke-bounds.value-object.ts";
import {
  type AgentSessionOpened,
  type EndedSpoke,
  endingOf,
  type RunStatus,
  type RunView,
  sessionOpenedIn,
  type SpokeEndRequest,
  SpokeHandOverJson,
  type SpokeReport,
  type SpokeSessionApi,
  type WorkItem,
} from "../../modules/runs/runs.platform.ts";
import { homePaths } from "../../platform/home.ts";
import {
  describeExit,
  endForeignGroup,
  groupAlive,
  type GroupExit,
  groupsMemory,
  type ProcessGroup,
  type ProcessIdentity,
  processIdentity,
  spawnGroup,
  STOP_GRACE,
  stopGroup,
} from "../../platform/process-group.ts";
import { selfCommand } from "../../platform/self.ts";
import { foldSpoke, ReportFold, reportFold } from "./report-fold.server.ts";

// A run the hub recorded, to hand to a spoke: its id, the run as recorded,
// the repo, flow and persona's login (none for the implicit persona), the
// item, and the tree of `.chernabog/` the hub trusted and loaded it from.
export type SpokeHandOver = {
  readonly runId: RunId;
  readonly run: RunView;
  readonly repo: string;
  readonly checkout: string;
  readonly flow: string;
  readonly persona: Option.Option<string>;
  readonly item: WorkItem;
  readonly tree: Option.Option<string>;
};

// The hub's live spokes.
export type Spokes = {
  // Spawns a spoke for a run the hub recorded and attached; fails, saying
  // why, when it couldn't, and the run is the hub's to end.
  readonly start: (handOver: SpokeHandOver) => Effect.Effect<void, string>;
  // Whether the run's spoke is live.
  readonly has: (runId: RunId) => boolean;
  // How many spokes are live.
  readonly live: Effect.Effect<number>;
  // Folds what the run's spoke has reported since the last fold, if it is
  // live: before the hub ends its run itself, so the ending sees its steps.
  readonly fold: (runId: RunId) => Effect.Effect<void>;
  // Stops the run's spoke, if it is live: SIGTERM to its group, then
  // SIGKILL after the grace. Its exit is handled as any other.
  readonly stop: (runId: RunId) => Effect.Effect<void>;
  // Ends the run's spoke, if it is live, for the ending its run is about to
  // take: the hub won't end the run from its exit, since whoever asked will.
  // SIGTERM to its group, SIGKILL after the grace, and waits until it has
  // exited and its last reports are folded. How it exited, and the agent
  // sessions it reported; none when no spoke of the run is live.
  readonly end: (
    runId: RunId,
    request: SpokeEndRequest,
  ) => Effect.Effect<Option.Option<EndedSpoke>>;
  // Forgets a spoke `end` ended, or `reap` reaped, once its run's ending is
  // recorded. Until then `end` answers for it as it did the first time, so a
  // second ending asked after the spoke exited is refused too.
  readonly forget: (runId: RunId) => Effect.Effect<void>;
  // Reaps a spoke the hub before this one recorded (ADR 23, decision 7): ends
  // its process group if its leader is still that spoke, folds what its
  // journal holds after the position recorded, and keeps the agent sessions
  // it reported, so `end` answers for it as for a spoke this hub ended, with
  // the ending meant for it first. Its run is the caller's to end.
  readonly reap: (left: LeftSpoke) => Effect.Effect<ReapedSpoke>;
};

// A spoke as the hub before this one recorded it (`om_spokes`).
export type LeftSpoke = {
  readonly runId: RunId;
  readonly pid: number;
  readonly startedAt: Option.Option<string>;
  readonly foldedSeq: number;
  readonly ending: Option.Option<SpokeEndRequest>;
};

// What reaping a spoke found: what became of its process, for the daemon's
// log, and whether its journal could be read.
export type ReapedSpoke = {
  readonly process: string;
  readonly journalRead: boolean;
};

// Whether the process with a recorded spoke's PID is still that spoke: the
// same start time, when the hub recorded one, and a command line that is a
// spoke's of that run. Anything else has the PID by reuse, and is never
// signalled.
export const isSpoke = (left: LeftSpoke, found: ProcessIdentity) => {
  const words = found.command.split(/\s+/);

  return (
    Option.match(left.startedAt, {
      onNone: () => true,
      onSome: (startedAt) => startedAt === found.startedAt,
    }) && words.some((word, at) => word === "--run" && words[at + 1] === left.runId)
  );
};

// What became of a recorded spoke's process: ended if it is still that spoke,
// left alone if its PID is another process's now. A spoke that exited may
// leave processes of its group running, whose leader is gone; with nothing
// to tell they were its, they are left alone, and said.
const reapProcess = (left: LeftSpoke, grace: Duration.Duration) =>
  Effect.gen(function* () {
    const found = yield* processIdentity(left.pid);

    if (Option.isNone(found) && (yield* groupAlive(left.pid))) {
      return `was gone, but left processes in its group ${left.pid}, which the hub can't tell were its and leaves alone`;
    }

    if (Option.isNone(found)) {
      return "was gone";
    }

    if (!isSpoke(left, found.value)) {
      return `was gone: PID ${left.pid} is another process's now, which the hub leaves alone`;
    }

    switch (yield* endForeignGroup(left.pid, grace)) {
      case "terminated":
        return `was still running, and stopped on SIGTERM`;
      case "killed":
        return `was still running, and was killed by SIGKILL`;
      case "survived":
        return `was still running, and its group outlived SIGKILL`;
    }
  });

const encodeHandOver = Schema.encodeSync(SpokeHandOverJson);

// How often the hub folds a live spoke's journal when no watch event says it
// grew (file events can stop on macOS under load, as watchStateChanges found).
export const TAIL_EVERY = Duration.seconds(2);

// How often the hub measures each live spoke against its bounds.
export const SAMPLE_EVERY = Duration.seconds(5);

// The longest the hub waits before it tries again to end a spoke past a
// bound.
export const BOUND_RETRY_CAP = Duration.minutes(5);

// How long the hub waits, after `failed` attempts to end a spoke past a bound
// came to nothing, before it measures the spoke and tries again: a sample's
// interval after the first, doubling with each one after, up to
// BOUND_RETRY_CAP. A cancel that keeps failing is then tried, and noted,
// rarely, not at every sample.
export const boundRetryAfter = (failed: number, every: Duration.Duration = SAMPLE_EVERY) =>
  Duration.min(Duration.times(every, 2 ** Math.max(0, failed - 1)), BOUND_RETRY_CAP);

// Where the hub is with ending a spoke past a bound: how many attempts it
// has made, whether one is under way, and when, in millis, it may make the
// next.
export type BoundEnding = {
  readonly attempts: number;
  readonly ending: boolean;
  readonly retryAt: number;
};

// Whether the hub measures a spoke at `now`: not while an attempt to end it
// is under way, nor before the next one is due.
export const measuredAt = (state: BoundEnding, now: number) =>
  !state.ending && now >= state.retryAt;

// How long past its phase-time bound a spoke stops itself, as `ci run` does
// in a CI job: well after the hub's bound, so that is the one that ends it,
// and the spoke's own stop is there only for a hub that stopped watching.
export const STOP_AFTER_MARGIN = Duration.minutes(5);

// What a spoke is told of its bounds: the bytes its telemetry and its run
// log stop at, and when it stops itself.
const boundArgs = (bounds: SpokeBounds) => [
  "--telemetry-limit",
  String(bounds.telemetry),
  "--run-log-limit",
  String(bounds.runLog),
  "--stop-after-seconds",
  String(Math.ceil(Duration.toSeconds(Duration.sum(bounds.phaseTime, STOP_AFTER_MARGIN)))),
];

// The spoke's command line, as `ci run --run` takes a hub's hand-over.
export const spokeArgs = (handOver: SpokeHandOver, handOverFile: string, bounds: SpokeBounds) => [
  "ci",
  "run",
  "--run",
  handOver.runId,
  "--repo",
  handOver.repo,
  "--flow",
  handOver.flow,
  ...Option.match(handOver.persona, { onNone: () => [], onSome: (login) => ["--persona", login] }),
  "--item",
  handOver.item.key,
  "--hand-over-file",
  handOverFile,
  ...Option.match(handOver.tree, { onNone: () => [], onSome: (tree) => ["--tree", tree] }),
  ...boundArgs(bounds),
];

// The next change to anything under `dir`, as a file watch says: `next`
// waits for it, for as long as the scope lasts. A watch that fails says
// nothing more, and whoever waits falls back on a poll.
export const watchChanges = (fs: FileSystem.FileSystem, dir: string) =>
  Effect.gen(function* () {
    let changed = yield* Deferred.make<boolean>();

    yield* Effect.forkScoped(
      Stream.runForEach(fs.watch(dir), () =>
        Effect.gen(function* () {
          const was = changed;
          changed = yield* Deferred.make<boolean>();
          yield* Deferred.succeed(was, true);
        }),
      ).pipe(Effect.ignore),
    );

    return { next: Effect.suspend(() => Deferred.await(changed)).pipe(Effect.asVoid) };
  });

// What a journal's files look like on disk: the database's and its
// write-ahead log's sizes and modification times. A spoke's write moves it;
// a reader opening and closing the journal, as each fold does, touches the
// shared memory and fires the watch, but moves neither, so the tail doesn't
// wake itself.
export const journalSignature = (fs: FileSystem.FileSystem, journal: string) =>
  Effect.forEach([journal, `${journal}-wal`], (path) =>
    fs.stat(path).pipe(
      Effect.map((info) =>
        [
          String(info.size),
          Option.match(info.mtime, { onNone: () => "", onSome: (at) => String(at.getTime()) }),
        ].join("@"),
      ),
      Effect.orElseSucceed(() => "none"),
    ),
  ).pipe(Effect.map((parts) => parts.join(" ")));

// The size of a file, or of every file under a folder; 0 for neither.
const sizeOf = (fs: FileSystem.FileSystem, path: string): Effect.Effect<number> =>
  Effect.gen(function* () {
    const info = yield* fs.stat(path);

    if (info.type !== "Directory") {
      return Number(info.size);
    }

    let total = 0;

    for (const name of yield* fs.readDirectory(path, { recursive: true })) {
      total += yield* fs.stat(`${path}/${name}`).pipe(
        Effect.map((found) => Option.liftPredicate(found, (one) => one.type === "File")),
        Effect.map(Option.match({ onNone: () => 0, onSome: (file) => Number(file.size) })),
        Effect.orElseSucceed(() => 0),
      );
    }

    return total;
  }).pipe(Effect.orElseSucceed(() => 0));

// The bytes each run's spoke has written as telemetry, summed over every day
// folder, by its run: a spoke's files are named for its run
// (`spoke-<run>-<pid>.jsonl`). One pass over the folders, for every spoke.
export const telemetryByRun = (fs: FileSystem.FileSystem, telemetry: string) =>
  Effect.gen(function* () {
    const byRun = new Map<string, number>();

    for (const day of yield* fs.readDirectory(telemetry)) {
      const files = yield* fs
        .readDirectory(`${telemetry}/${day}`)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

      for (const file of files.filter((name) => name.startsWith("spoke-"))) {
        // spoke-<run>-<pid>.jsonl: the run is everything before the last dash.
        const run = file.slice("spoke-".length, file.lastIndexOf("-"));
        byRun.set(run, (byRun.get(run) ?? 0) + (yield* sizeOf(fs, `${telemetry}/${day}/${file}`)));
      }
    }

    return byRun;
  }).pipe(Effect.orElseSucceed(() => new Map<string, number>()));

// What the run's files look like: its journal's, its run log's size and the
// transcripts' of the sessions its spoke reported. A change in it is the
// spoke getting somewhere; the same for as long as the idle bound is a spoke
// gone idle.
export const activityOf = (
  fs: FileSystem.FileSystem,
  home: string,
  runId: RunId,
  sessions: ReadonlyArray<AgentSessionOpened>,
) =>
  Effect.gen(function* () {
    const paths = homePaths(home);
    const journal = yield* journalSignature(fs, paths.journal(runId));
    const runLog = yield* sizeOf(fs, paths.runLog(runId));

    const transcripts = yield* Effect.forEach(
      sessions.flatMap((session) => session.transcripts ?? []),
      (path) => sizeOf(fs, path),
    );

    return [journal, String(runLog), ...transcripts.map(String)].join(" ");
  });

// When a spoke last got somewhere: what its files looked like then, and when.
export type SpokeActivity = { readonly signature: string; readonly at: number };

// The spoke's activity after a sample that found its files looking like
// `signature` at `now`: moved on if they changed, else as it was.
export const nextActivity = (last: SpokeActivity, signature: string, now: number): SpokeActivity =>
  Option.getOrElse(
    Option.liftPredicate(last, (was) => was.signature === signature),
    () => ({ signature, at: now }),
  );

// One spoke measured, from what the hub sampled at `now`.
export const measureOf = (sample: {
  readonly now: number;
  readonly startedAt: number;
  readonly activity: SpokeActivity;
  readonly telemetry: number;
  readonly runLog: number;
  readonly memory: Option.Option<number>;
}): SpokeMeasure => ({
  telemetry: sample.telemetry,
  runLog: sample.runLog,
  phaseTime: Duration.millis(Math.max(0, sample.now - sample.startedAt)),
  idle: Duration.millis(Math.max(0, sample.now - sample.activity.at)),
  memory: sample.memory,
});

// The environment a spoke runs in: the hub's, in the hub's home, never with
// an API key, which would bill claude by the token.
export const spokeEnvironment = (
  variables: Readonly<Record<string, string>>,
  home: string,
): Readonly<Record<string, string>> => ({
  ...Record.remove(variables, "ANTHROPIC_API_KEY"),
  CHERNABOG_HOME: home,
});

// Folds a live spoke's journal for as long as it lives: at once, then
// whenever its files have changed since the last fold, looked at on each
// change under the journals or every `every`, whichever is first. A journal
// that hasn't changed isn't read.
export const tailSpoke = (options: {
  readonly fold: Effect.Effect<void>;
  readonly signature: Effect.Effect<string>;
  readonly changed: Effect.Effect<void>;
  readonly every: Duration.Duration;
}) =>
  Effect.gen(function* () {
    let folded = Option.none<string>();

    for (;;) {
      // Taken before the fold, so a write during it is folded the next time.
      const now = yield* options.signature;

      if (!Option.contains(folded, now)) {
        yield* options.fold;
        folded = Option.some(now);
      }

      yield* options.changed.pipe(Effect.timeoutOption(options.every));
    }
  });

export const hubSpokes = <R>(options: {
  readonly home: string;
  // What a spoke runs, before its hand-over's arguments: the hub's own
  // executable, unless a test gives another.
  readonly command?: ReadonlyArray<string>;
  readonly variables: Readonly<Record<string, string>>;
  readonly log: (line: string) => Effect.Effect<void>;
  // The reports a run's spoke wrote after `after`, and what folding one into
  // state.db does (ADR 23, decisions 3 and 8).
  readonly reports: (
    runId: RunId,
    after: number,
  ) => Effect.Effect<ReadonlyArray<SpokeReport>, never, R>;
  readonly apply: (runId: RunId, report: SpokeReport) => Effect.Effect<void, never, R>;
  // Records a spoke once it is spawned, and the ending the hub means for it
  // (ADR 23, decision 7), so the next hub can finish what this one started.
  readonly record: (spoke: {
    readonly runId: RunId;
    readonly pid: number;
    readonly startedAt: Option.Option<string>;
    readonly hubPid: number;
    readonly hubStartedAt: Option.Option<string>;
  }) => Effect.Effect<void, never, R>;
  readonly intend: (runId: RunId, request: SpokeEndRequest) => Effect.Effect<void, never, R>;
  // Ends a run once its spoke exited, from what it reported, unless the hub
  // meant an ending for it (`end`), which whoever asked gives the run.
  readonly onExit: (
    runId: RunId,
    exit: GroupExit,
    intended: Option.Option<RunStatus>,
  ) => Effect.Effect<void, never, R>;
  // What the hub holds each spoke to, and what it does with one past a
  // bound: ends its run, through `end` (ADR 23, decision 4).
  readonly bounds: SpokeBounds;
  // Whether it ended the run: one it couldn't is measured again once
  // `boundRetryAfter` its failed attempts, and handed over again, with the
  // attempt's number (1 the first), while it is still past a bound.
  readonly onBound: (
    runId: RunId,
    breach: SpokeBreach,
    attempt: number,
  ) => Effect.Effect<boolean, never, R>;
  // Every process group's resident memory, by its id; `ps`'s, unless a test
  // says otherwise.
  readonly memory?: Effect.Effect<ReadonlyMap<number, number>>;
  readonly sampleEvery?: Duration.Duration;
  // How long a reaped spoke gets after SIGTERM before SIGKILL; STOP_GRACE,
  // unless a test says otherwise.
  readonly reapGrace?: Duration.Duration;
  // Where the hub's session API listens and a run's key (ADR 24), handed to
  // the run's spoke; none when the hub has no session API.
  readonly sessionApi?: (runId: RunId) => Option.Option<typeof SpokeSessionApi.Type>;
}): Effect.Effect<Spokes, never, R | FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<R>();
    const paths = homePaths(options.home);

    // Each live spoke: its process group; a fold of its journal, which runs
    // one at a time however many ask for it; the agent sessions it reported;
    // the ending the hub means for it, once one does; and done once it has
    // exited and been folded for the last time.
    const live = new Map<
      RunId,
      {
        readonly group: ProcessGroup;
        readonly fold: Effect.Effect<void>;
        readonly sessions: Array<AgentSessionOpened>;
        readonly done: Deferred.Deferred<boolean>;
        // When it was spawned, and when its files last changed, in millis.
        readonly startedAt: number;
        readonly activity: Ref.Ref<SpokeActivity>;
        // Where the hub is with ending it past a bound, through `onBound`.
        readonly bounding: Ref.Ref<BoundEnding>;
      }
    >();

    // Each spoke `end` ended, as it was ended, until its run's ending is
    // recorded and the hub forgets it.
    // Registered by the first `end` the moment it is asked, before anything
    // yields, so every later `end`, before or after the spoke leaves `live`,
    // waits on the same answer.
    const ended = new Map<
      RunId,
      {
        readonly request: SpokeEndRequest;
        readonly endedFor: RunStatus;
        readonly result: Deferred.Deferred<EndedSpoke>;
      }
    >();

    // Each spoke `reap` reaped: the ending meant for it first, how its
    // process went and the sessions it reported, until its run's ending is
    // recorded and the hub forgets it.
    const reaped = new Map<
      RunId,
      {
        readonly intended: Ref.Ref<Option.Option<SpokeEndRequest>>;
        readonly exit: string;
        readonly sessions: ReadonlyArray<AgentSessionOpened>;
      }
    >();

    // The hub's own process, for each spoke's record.
    const hub = { pid: process.pid, startedAt: yield* processIdentity(process.pid) };

    const [program, ...prefix] = Option.getOrElse(Option.fromUndefinedOr(options.command), () =>
      selfCommand(),
    );

    yield* fs.makeDirectory(paths.journals, { recursive: true }).pipe(Effect.ignore);

    const journalsChanged = yield* watchChanges(fs, paths.journals);

    const tail = (runId: RunId, fold: Effect.Effect<void>) =>
      tailSpoke({
        fold,
        signature: journalSignature(fs, paths.journal(runId)),
        changed: journalsChanged.next,
        every: TAIL_EVERY,
      });

    // A hub that stops ends its spokes, waiting for none: their runs are the
    // next hub's to end (ADR 23, decision 7). Closing their stdin does the
    // same for a hub that dies without running this.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...live.values()],
        ({ group }) => Effect.andThen(group.signal("SIGTERM"), group.closeStdin),
        { discard: true },
      ),
    );

    const handOverFileOf = (runId: RunId) => `${paths.spokes}/${runId}.hand-over.json`;

    const start = (handOver: SpokeHandOver) =>
      Effect.gen(function* () {
        const handOverFile = handOverFileOf(handOver.runId);
        yield* fs.makeDirectory(paths.spokes, { recursive: true });

        const sessionApi = Option.flatMap(Option.fromUndefinedOr(options.sessionApi), (of) =>
          of(handOver.runId),
        );

        // It holds the run's key, so only its owner may read it; chmod covers
        // a file left from before it was written this way.
        yield* fs.writeFileString(
          handOverFile,
          encodeHandOver({
            run: handOver.run,
            item: handOver.item,
            ...Option.match(sessionApi, {
              onNone: () => ({}),
              onSome: (given) => ({ sessionApi: given }),
            }),
          }),
          { mode: 0o600 },
        );
        yield* fs.chmod(handOverFile, 0o600);

        const group = yield* spawnGroup(
          program,
          [...prefix, ...spokeArgs(handOver, handOverFile, options.bounds)],
          {
            cwd: handOver.checkout,
            env: spokeEnvironment(options.variables, options.home),
          },
        );

        const folded = yield* Ref.make(0);
        const folding = yield* Semaphore.make(1);
        const sessions: Array<AgentSessionOpened> = [];
        const done = yield* Deferred.make<boolean>();
        const startedAt = yield* Clock.currentTimeMillis;
        const activity = yield* Ref.make<SpokeActivity>({ signature: "", at: startedAt });
        const bounding = yield* Ref.make<BoundEnding>({ attempts: 0, ending: false, retryAt: 0 });

        // A session the spoke opened stays with the spoke; any other report
        // is the hub's to fold into state.db.
        const apply = (runId: RunId, report: SpokeReport) =>
          ReportFold.$match(reportFold(report), {
            Session: ({ opened }) =>
              Effect.sync(() => {
                sessions.push(opened);
              }),
            Dispatch: () => options.apply(runId, report),
            Skip: () => options.apply(runId, report),
            Ending: () => options.apply(runId, report),
          });

        // A journal the hub can't read now is read again at the next fold.
        const reports = (runId: RunId, after: number) =>
          options
            .reports(runId, after)
            .pipe(
              Effect.catchCause((cause) =>
                options
                  .log(`could not read the reports of ${shortRunId(runId)}: ${String(cause)}`)
                  .pipe(Effect.as([])),
              ),
            );

        const fold = foldSpoke(handOver.runId, folded, reports, apply).pipe(
          folding.withPermits(1),
          Effect.provideContext(context),
        );

        live.set(handOver.runId, {
          group,
          fold,
          sessions,
          done,
          startedAt,
          activity,
          bounding,
        });

        const short = shortRunId(handOver.runId);
        yield* options.log(`spawned spoke ${group.pid} for ${short}`);

        // Recorded so the next hub can end its run if this one dies first,
        // and tell it from a later process with its PID. One that never
        // started has no process to record. The spoke is live already, so an
        // `end` asked meanwhile meant its ending for no record yet: that
        // ending is written to the record once it exists (the first recorded
        // wins, so one `end` wrote itself is written once).
        if (group.pid > 0) {
          yield* options
            .record({
              runId: handOver.runId,
              pid: group.pid,
              startedAt: Option.map(yield* processIdentity(group.pid), (found) => found.startedAt),
              hubPid: hub.pid,
              hubStartedAt: Option.map(hub.startedAt, (found) => found.startedAt),
            })
            .pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  Option.match(Option.fromUndefinedOr(ended.get(handOver.runId)), {
                    onNone: () => Effect.void,
                    onSome: (meant) => options.intend(handOver.runId, meant.request),
                  }),
                ),
              ),
              Effect.provideContext(context),
            );
        }

        yield* Effect.forkIn(
          Stream.runForEach(group.lines, (line) => options.log(`spoke ${short}: ${line.text}`)),
          scope,
        );

        const tailing = yield* Effect.forkIn(tail(handOver.runId, fold), scope);

        // Once the spoke has exited, its tail stops, and what it wrote since
        // the last fold is folded before its run ends: the steps, markers and
        // usage its ending releases or reports are in state.db first.
        yield* Effect.forkIn(
          Effect.gen(function* () {
            const exit = yield* group.exited;
            yield* Fiber.interrupt(tailing);
            yield* fold;
            live.delete(handOver.runId);
            yield* fs.remove(handOverFile, { force: true }).pipe(Effect.ignore);
            yield* options.onExit(
              handOver.runId,
              exit,
              Option.map(
                Option.fromUndefinedOr(ended.get(handOver.runId)),
                (meant) => meant.endedFor,
              ),
            );
          }).pipe(Effect.ensuring(Deferred.succeed(done, true)), Effect.provideContext(context)),
          scope,
        );
      }).pipe(Effect.mapError((error) => `could not hand it to a spoke: ${error.message}`));

    const every = options.sampleEvery ?? SAMPLE_EVERY;

    // Hands a spoke past a bound to `onBound`, on a fiber of its own: ending
    // it waits out its grace, which holds up no other spoke's sample. One it
    // couldn't end waits `boundRetryAfter` its failed attempts before the
    // hub measures it again.
    const endPastBound = (runId: RunId, bounding: Ref.Ref<BoundEnding>, breach: SpokeBreach) =>
      Effect.gen(function* () {
        const { attempts } = yield* Ref.updateAndGet(bounding, (state) => ({
          attempts: state.attempts + 1,
          ending: true,
          retryAt: state.retryAt,
        }));

        yield* Effect.forkIn(
          options.onBound(runId, breach, attempts).pipe(
            Effect.flatMap((endedRun) =>
              Effect.when(
                Effect.flatMap(Clock.currentTimeMillis, (at) =>
                  Ref.set(bounding, {
                    attempts,
                    ending: false,
                    retryAt: at + Duration.toMillis(boundRetryAfter(attempts, every)),
                  }),
                ),
                Effect.succeed(!endedRun),
              ),
            ),
            Effect.provideContext(context),
          ),
          scope,
        );
      });

    // Measures every live spoke against its bounds, and hands one past a
    // bound to `endPastBound`, and not again unless that couldn't end its run.
    const sample = Effect.gen(function* () {
      if (live.size === 0) {
        return;
      }

      const memory = yield* options.memory ?? groupsMemory;
      const telemetry = yield* telemetryByRun(fs, paths.telemetry);
      const now = yield* Clock.currentTimeMillis;

      for (const [runId, spoke] of [...live.entries()]) {
        if (!measuredAt(yield* Ref.get(spoke.bounding), now)) {
          continue;
        }

        const signature = yield* activityOf(fs, options.home, runId, spoke.sessions);

        const activity = yield* Ref.updateAndGet(spoke.activity, (last) =>
          nextActivity(last, signature, now),
        );

        const measure = measureOf({
          now,
          startedAt: spoke.startedAt,
          activity,
          telemetry: telemetry.get(runId) ?? 0,
          runLog: yield* sizeOf(fs, paths.runLog(runId)),
          memory: Option.fromUndefinedOr(memory.get(spoke.group.pid)),
        });

        for (const breach of Option.toArray(breachOf(measure, options.bounds))) {
          yield* endPastBound(runId, spoke.bounding, breach);
        }
      }
    });

    yield* Effect.forkScoped(
      sample.pipe(
        Effect.catchCause((cause) => options.log(`sampling spokes failed: ${String(cause)}`)),
        Effect.repeat(Schedule.spaced(every)),
      ),
    );

    // A spoke the hub reaped, as `end` answers for it: ended for the first
    // ending asked of it, the one the hub before meant if it recorded one.
    const reapedAnswer = (runId: RunId, request: SpokeEndRequest) =>
      Option.match(Option.fromUndefinedOr(reaped.get(runId)), {
        onNone: () => Effect.succeedNone,
        onSome: (spoke) =>
          Effect.map(
            Ref.modify(spoke.intended, (meant) => {
              const held = Option.getOrElse(meant, () => request);

              return [held, Option.some(held)] as const;
            }),
            (first): Option.Option<EndedSpoke> =>
              Option.some({
                endedFor: endingOf(first),
                exit: spoke.exit,
                sessions: [...spoke.sessions],
              }),
          ),
      });

    const reap = (left: LeftSpoke) =>
      Effect.gen(function* () {
        const process = yield* reapProcess(left, options.reapGrace ?? STOP_GRACE);
        const sessions: Array<AgentSessionOpened> = [];

        // Every report, for the sessions it reported, whenever it did; each
        // after the recorded position folded, moving it on, as a live fold.
        const read = yield* options.reports(left.runId, 0).pipe(
          Effect.asSome,
          Effect.catchCause((cause) =>
            options
              .log(`could not read the reports of ${shortRunId(left.runId)}: ${String(cause)}`)
              .pipe(Effect.as(Option.none<ReadonlyArray<SpokeReport>>())),
          ),
        );

        for (const report of Option.getOrElse(read, () => [])) {
          for (const opened of Option.toArray(sessionOpenedIn(report))) {
            sessions.push(opened);
          }

          if (report.seq > left.foldedSeq) {
            yield* Effect.uninterruptible(options.apply(left.runId, report));
          }
        }

        reaped.set(left.runId, {
          intended: yield* Ref.make(left.ending),
          exit: `its spoke from before ${process}`,
          sessions,
        });

        yield* fs.remove(handOverFileOf(left.runId), { force: true }).pipe(Effect.ignore);

        return { process, journalRead: Option.isSome(read) };
      }).pipe(Effect.provideContext(context));

    return {
      start,
      has: (runId) => live.has(runId),
      live: Effect.sync(() => live.size),
      fold: (runId) =>
        Option.match(Option.fromUndefinedOr(live.get(runId)), {
          onNone: () => Effect.void,
          onSome: (spoke) => spoke.fold,
        }),
      stop: (runId) =>
        Option.match(Option.fromUndefinedOr(live.get(runId)), {
          onNone: () => Effect.void,
          onSome: ({ group }) =>
            Effect.forkIn(stopGroup(group, STOP_GRACE), scope).pipe(Effect.asVoid),
        }),
      end: (runId, request) =>
        Effect.suspend(() =>
          Option.match(Option.fromUndefinedOr(ended.get(runId)), {
            // The first ending asked of it holds: a cancel and a lost lease at
            // once end it as whichever asked first, and the other hears so.
            onSome: (asked) => Effect.asSome(Deferred.await(asked.result)),
            onNone: () =>
              Option.match(Option.fromUndefinedOr(live.get(runId)), {
                onNone: () => reapedAnswer(runId, request),
                onSome: (spoke) => {
                  const ending = endingOf(request);
                  const result = Deferred.makeUnsafe<EndedSpoke>();
                  ended.set(runId, { request, endedFor: ending, result });

                  return Effect.gen(function* () {
                    // Recorded on the spoke's record before it is signalled,
                    // so a hub that dies meanwhile is finished by the next as
                    // this one meant (ADR 23, decision 7).
                    yield* options.intend(runId, request).pipe(Effect.provideContext(context));

                    const exit = yield* stopGroup(spoke.group, STOP_GRACE);
                    yield* Deferred.await(spoke.done);

                    const answer: EndedSpoke = {
                      endedFor: ending,
                      exit: describeExit(exit),
                      sessions: [...spoke.sessions],
                    };

                    yield* Deferred.succeed(result, answer);

                    return Option.some(answer);
                  }).pipe(Effect.uninterruptible);
                },
              }),
          }),
        ),
      forget: (runId) =>
        Effect.sync(() => {
          ended.delete(runId);
          reaped.delete(runId);
        }),
      reap,
    } satisfies Spokes;
  });
