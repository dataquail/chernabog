// The hub's spokes (ADR 23): each run the daemon starts executes in a process
// of its own, the hub's own executable as `ci run --run`, leading a process
// group of its own, with a pipe on its stdin the hub holds for the spoke's
// whole life. The hub keeps each live spoke's handle here, by its run, until
// the spoke exits; then it ends the run from what the spoke reported.
//
// What later layers hook into: `start`'s handle (the PID and process group
// `om_spokes` records, #664), `stop` (cancel, #662, and the bounds, #663),
// and `onExit` (a park's ending, #660, and the final fold, #661).

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { type RunId, shortRunId } from "../../kernel/run-id.id.ts";
import { WorkItem } from "../../modules/runs/runs.platform.ts";
import { homePaths } from "../../platform/home.ts";
import {
  type GroupExit,
  type ProcessGroup,
  spawnGroup,
  STOP_GRACE,
  stopGroup,
} from "../../platform/process-group.ts";
import { selfCommand } from "../../platform/self.ts";

// A run the hub recorded, to hand to a spoke: its id, the repo, flow and
// persona's login (none for the implicit persona), the item, and the tree of
// `.chernabog/` the hub trusted and loaded it from.
export type SpokeHandOver = {
  readonly runId: RunId;
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

const encodeItem = Schema.encodeSync(Schema.fromJsonString(WorkItem));

// The spoke's command line, as `ci run --run` takes a hub's hand-over.
export const spokeArgs = (handOver: SpokeHandOver, itemFile: string) => [
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
  "--work-item-file",
  itemFile,
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

export const hubSpokes = <R>(options: {
  readonly home: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly log: (line: string) => Effect.Effect<void>;
  readonly onExit: (runId: RunId, exit: GroupExit) => Effect.Effect<void, never, R>;
}): Effect.Effect<Spokes, never, R | FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<R>();
    const paths = homePaths(options.home);
    const live = new Map<RunId, ProcessGroup>();
    const [program, ...prefix] = selfCommand();

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

    const itemFileOf = (runId: RunId) => `${paths.spokes}/${runId}.item.json`;

    const start = (handOver: SpokeHandOver) =>
      Effect.gen(function* () {
        const itemFile = itemFileOf(handOver.runId);
        yield* fs.makeDirectory(paths.spokes, { recursive: true });
        yield* fs.writeFileString(itemFile, encodeItem(handOver.item));

        const group = yield* spawnGroup(program, [...prefix, ...spokeArgs(handOver, itemFile)], {
          cwd: handOver.checkout,
          env: spokeEnvironment(options.variables, options.home),
        });

        live.set(handOver.runId, group);

        const short = shortRunId(handOver.runId);
        yield* options.log(`spawned spoke ${group.pid} for ${short}`);

        yield* Effect.forkIn(
          Stream.runForEach(group.lines, (line) => options.log(`spoke ${short}: ${line.text}`)),
          scope,
        );

        yield* Effect.forkIn(
          Effect.gen(function* () {
            const exit = yield* group.exited;
            live.delete(handOver.runId);
            yield* fs.remove(itemFile, { force: true }).pipe(Effect.ignore);
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
