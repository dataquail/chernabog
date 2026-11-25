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
// What later layers hook into: `start`'s handle (the PID and process group
// `om_spokes` records, #664, which also keeps the fold position and the
// intended ending there, where here they are the hub's memory), `end` (the
// bounds, #663, which also watch the sessions' transcripts).

import type { Command } from "@effect-server-utils/cqrs";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { type RunId, shortRunId } from "../../kernel/run-id.id.ts";
import {
  type AgentSessionOpened,
  type EndedSpoke,
  type RunStatus,
  type RunView,
  sessionOpenedIn,
  SpokeHandOverJson,
  type SpokeReport,
  spokeReportCommands,
  spokeReportPayloadJson,
  type WorkItem,
} from "../../modules/runs/runs.platform.ts";
import { homePaths } from "../../platform/home.ts";
import {
  describeExit,
  type GroupExit,
  type ProcessGroup,
  spawnGroup,
  STOP_GRACE,
  stopGroup,
} from "../../platform/process-group.ts";
import { selfCommand } from "../../platform/self.ts";

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
  readonly end: (runId: RunId, ending: RunStatus) => Effect.Effect<Option.Option<EndedSpoke>>;
  // Forgets a spoke `end` ended, once its run's ending is recorded. Until
  // then `end` answers for it as it did the first time, so a second ending
  // asked after the spoke exited is refused too.
  readonly forget: (runId: RunId) => Effect.Effect<void>;
};

const encodeHandOver = Schema.encodeSync(SpokeHandOverJson);

// How often the hub folds a live spoke's journal when no watch event says it
// grew (file events can stop on macOS under load, as watchStateChanges found).
export const TAIL_EVERY = Duration.seconds(2);

// The spoke's command line, as `ci run --run` takes a hub's hand-over.
export const spokeArgs = (handOver: SpokeHandOver, handOverFile: string) => [
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
];

// The environment a spoke runs in: the hub's, in the hub's home, never with
// an API key, which would bill claude by the token.
export const spokeEnvironment = (
  variables: Readonly<Record<string, string>>,
  home: string,
): Readonly<Record<string, string>> => ({
  ...Record.remove(variables, "ANTHROPIC_API_KEY"),
  CHERNABOG_HOME: home,
});

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

// Folds a spoke's reports after `folded` into state.db, in order. Each report
// and the position past it move together, uninterruptibly, so a tail stopped
// midway leaves no report folded that the next fold takes again.
export const foldSpoke = <R>(
  runId: RunId,
  folded: Ref.Ref<number>,
  reports: (runId: RunId, after: number) => Effect.Effect<ReadonlyArray<SpokeReport>, never, R>,
  apply: (runId: RunId, report: SpokeReport) => Effect.Effect<void, never, R>,
) =>
  Effect.gen(function* () {
    for (const report of yield* reports(runId, yield* Ref.get(folded))) {
      yield* Effect.uninterruptible(
        apply(runId, report).pipe(Effect.andThen(Ref.set(folded, report.seq))),
      );
    }
  });

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
  readonly variables: Readonly<Record<string, string>>;
  readonly log: (line: string) => Effect.Effect<void>;
  // The reports a run's spoke wrote after `after`, and what folding one into
  // state.db does (ADR 23, decisions 3 and 8).
  readonly reports: (
    runId: RunId,
    after: number,
  ) => Effect.Effect<ReadonlyArray<SpokeReport>, never, R>;
  readonly apply: (runId: RunId, report: SpokeReport) => Effect.Effect<void, never, R>;
  // Ends a run once its spoke exited, from what it reported, unless the hub
  // meant an ending for it (`end`), which whoever asked gives the run.
  readonly onExit: (
    runId: RunId,
    exit: GroupExit,
    intended: Option.Option<RunStatus>,
  ) => Effect.Effect<void, never, R>;
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
        readonly intended: Ref.Ref<Option.Option<RunStatus>>;
        readonly done: Deferred.Deferred<boolean>;
      }
    >();

    // Each spoke `end` ended, as it was ended, until its run's ending is
    // recorded and the hub forgets it.
    const ended = new Map<RunId, EndedSpoke>();

    const [program, ...prefix] = selfCommand();

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

        yield* fs.writeFileString(
          handOverFile,
          encodeHandOver({ run: handOver.run, item: handOver.item }),
        );

        const group = yield* spawnGroup(
          program,
          [...prefix, ...spokeArgs(handOver, handOverFile)],
          {
            cwd: handOver.checkout,
            env: spokeEnvironment(options.variables, options.home),
          },
        );

        const folded = yield* Ref.make(0);
        const folding = yield* Semaphore.make(1);
        const sessions: Array<AgentSessionOpened> = [];
        const intended = yield* Ref.make(Option.none<RunStatus>());
        const done = yield* Deferred.make<boolean>();

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

        const fold = foldSpoke(handOver.runId, folded, options.reports, apply).pipe(
          folding.withPermits(1),
          Effect.provideContext(context),
        );

        live.set(handOver.runId, { group, fold, sessions, intended, done });

        const short = shortRunId(handOver.runId);
        yield* options.log(`spawned spoke ${group.pid} for ${short}`);

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
            yield* options.onExit(handOver.runId, exit, yield* Ref.get(intended));
          }).pipe(Effect.ensuring(Deferred.succeed(done, true)), Effect.provideContext(context)),
          scope,
        );
      }).pipe(Effect.mapError((error) => `could not hand it to a spoke: ${error.message}`));

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
      end: (runId, ending) =>
        Option.match(Option.fromUndefinedOr(live.get(runId)), {
          onNone: () => Effect.sync(() => Option.fromUndefinedOr(ended.get(runId))),
          onSome: (spoke) =>
            Effect.gen(function* () {
              // The first ending meant for it holds: a cancel and a lost
              // lease at once end it as whichever asked first, and the other
              // hears so.
              const endedFor = yield* Ref.modify(spoke.intended, (meant) => {
                const first = Option.getOrElse(meant, () => ending);

                return [first, Option.some(first)] as const;
              });

              const exit = yield* stopGroup(spoke.group, STOP_GRACE);
              yield* Deferred.await(spoke.done);

              const result: EndedSpoke = {
                endedFor,
                exit: describeExit(exit),
                sessions: [...spoke.sessions],
              };

              if (!ended.has(runId)) {
                ended.set(runId, result);
              }

              return Option.some(result);
            }),
        }),
      forget: (runId) =>
        Effect.sync(() => {
          ended.delete(runId);
        }),
    } satisfies Spokes;
  });
