// The hub's spokes (ADR 23): each run the daemon starts executes in a process
// of its own, the hub's own executable as `ci run --run`, leading a process
// group of its own, with a pipe on its stdin the hub holds for the spoke's
// whole life. The hub keeps each live spoke's handle here, by its run, until
// the spoke exits; then it ends the run from what the spoke reported.
//
// While a spoke lives, the hub tails its journal (ADR 23, decision 8): on a
// watch of the journals, with a poll behind it every 2 seconds, it folds each
// report the spoke appended since the last into state.db, in order, and once
// the spoke has exited it folds what's left before it ends the run. Spokes
// push nothing: what the hub knows of a run in flight is what its spoke wrote
// to disk. The hub reads nothing of a spoke's stdout but log lines.
//
// What later layers hook into: `start`'s handle (the PID and process group
// `om_spokes` records, #664, which also keeps the fold position there, in
// the fold's transaction, where here it is the hub's memory), `stop`
// (cancel, #662, and the bounds, #663).

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
import * as Stream from "effect/Stream";

import { type RunId, shortRunId } from "../../kernel/run-id.id.ts";
import {
  type RunView,
  SpokeHandOverJson,
  type SpokeReport,
  spokeReportCommands,
  spokeReportPayloadJson,
  type WorkItem,
} from "../../modules/runs/runs.platform.ts";
import { homePaths } from "../../platform/home.ts";
import {
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
  // Stops the run's spoke, if it is live: SIGTERM to its group, then
  // SIGKILL after the grace. Its exit is handled as any other.
  readonly stop: (runId: RunId) => Effect.Effect<void>;
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
// payload, skip it saying why, or nothing, for the spoke's ending, which the
// hub reads apart once the spoke has exited.
export type ReportFold = Data.TaggedEnum<{
  Dispatch: {
    readonly command: (typeof spokeReportCommands.messages)[number];
    readonly payload: unknown;
  };
  Skip: { readonly why: string };
  Ending: Record<never, never>;
}>;

export const ReportFold = Data.taggedEnum<ReportFold>();

// A report as the runs' command it carries, decoded with that command's own
// schema; one the hub doesn't fold, or can't read, is skipped.
export const reportFold = (report: SpokeReport): ReportFold => {
  if (report.tag === "RunEnded") {
    return ReportFold.Ending();
  }

  return Option.match(
    Option.fromUndefinedOr(spokeReportCommands.messages.find((known) => known.tag === report.tag)),
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
  readonly onExit: (runId: RunId, exit: GroupExit) => Effect.Effect<void, never, R>;
}): Effect.Effect<Spokes, never, R | FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<R>();
    const paths = homePaths(options.home);
    const live = new Map<RunId, ProcessGroup>();
    const [program, ...prefix] = selfCommand();

    // Completed, and replaced, whenever a journal changes: what wakes every
    // tail before its poll is due.
    let changed = yield* Deferred.make<boolean>();

    yield* fs.makeDirectory(paths.journals, { recursive: true }).pipe(Effect.ignore);

    yield* Effect.forkIn(
      Stream.runForEach(fs.watch(paths.journals), () =>
        Effect.gen(function* () {
          const was = changed;
          changed = yield* Deferred.make<boolean>();
          yield* Deferred.succeed(was, true);
        }),
      ).pipe(Effect.ignore),
      scope,
    );

    const nextChange = Effect.suspend(() => Deferred.await(changed));

    // Folds a live spoke's journal for as long as it lives: at once, then on
    // each change to the journals or every TAIL_EVERY, whichever is first.
    const tail = (runId: RunId, folded: Ref.Ref<number>) =>
      Effect.forever(
        foldSpoke(runId, folded, options.reports, options.apply).pipe(
          Effect.andThen(nextChange.pipe(Effect.timeoutOption(TAIL_EVERY))),
        ),
      );

    // A hub that stops ends its spokes, waiting for none: their runs are the
    // next hub's to end (ADR 23, decision 7). Closing their stdin does the
    // same for a hub that dies without running this.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...live.values()],
        (group) => Effect.andThen(group.signal("SIGTERM"), group.closeStdin),
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

        live.set(handOver.runId, group);

        const short = shortRunId(handOver.runId);
        yield* options.log(`spawned spoke ${group.pid} for ${short}`);

        yield* Effect.forkIn(
          Stream.runForEach(group.lines, (line) => options.log(`spoke ${short}: ${line.text}`)),
          scope,
        );

        const folded = yield* Ref.make(0);

        const tailing = yield* Effect.forkIn(
          tail(handOver.runId, folded).pipe(Effect.provideContext(context)),
          scope,
        );

        // Once the spoke has exited, its tail stops, and what it wrote since
        // the last fold is folded before its run ends: the steps, markers and
        // usage its ending releases or reports are in state.db first.
        yield* Effect.forkIn(
          Effect.gen(function* () {
            const exit = yield* group.exited;
            yield* Fiber.interrupt(tailing);
            yield* foldSpoke(handOver.runId, folded, options.reports, options.apply);
            live.delete(handOver.runId);
            yield* fs.remove(handOverFile, { force: true }).pipe(Effect.ignore);
            yield* options.onExit(handOver.runId, exit);
          }).pipe(Effect.provideContext(context)),
          scope,
        );
      }).pipe(Effect.mapError((error) => `could not hand it to a spoke: ${error.message}`));

    return {
      start,
      has: (runId) => live.has(runId),
      live: Effect.sync(() => live.size),
      stop: (runId) =>
        Option.match(Option.fromUndefinedOr(live.get(runId)), {
          onNone: () => Effect.void,
          onSome: (group) => Effect.forkIn(stopGroup(group, STOP_GRACE), scope).pipe(Effect.asVoid),
        }),
    } satisfies Spokes;
  });
