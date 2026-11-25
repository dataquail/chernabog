// One run of a flow in this process, in the foreground, as `chernabog run
// --from-checkout` (or `run` with no daemon) does: opens the repo, builds its
// personas' services and the engine, and starts a run, following its log to
// its boundary. The process is the run's own hub (ADR 23, decision 9): the run
// executes here in a journal of its own, which this process folds into its
// state.db, and it ends where it parks.

import { isManual, triggerOf, type WorkItem } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { nothingNamed } from "../../kernel/manual-flow.value-object.ts";
import { type Persona } from "../../kernel/persona.value-object.ts";
import { type RunId, runLabel } from "../../kernel/run-id.id.ts";
import {
  adoptRuns,
  buildPersonaContexts,
  defaultPersona,
  EngineLive,
  type FlowHandle,
  flowHandle,
  flowLayer,
  flowOrigins,
  noHooks,
  openRepo,
  type RepoContext,
  Routing,
  RunFlowsCommands,
  runLogFile,
  RunsQueries,
  type RunView,
  servicesFrom,
  unreportedItem,
  withRepo,
} from "../../modules/runs/runs.platform.ts";
import { ConfigError } from "../../platform/config-error.ts";
import { Home, homePaths } from "../../platform/home.ts";
import { acquireLock } from "../../platform/lock.ts";
import { type EffectiveRepo, findEnrolled, loadMachineConfig } from "../../repo-config.ts";
import { engineRuntime } from "../application-runtime.ts";
import { followOwnRun, startOwnRun, takeOverLeftRun } from "./own-hub.main.ts";

// Prints what a log file gains, from where it was last read.
export const tailer = (path: string) => {
  let offset = 0;

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    if (!(yield* fs.exists(path))) {
      return;
    }

    const text = yield* fs.readFileString(path);

    if (text.length <= offset) {
      return;
    }

    const fresh = text.slice(offset);
    offset = text.length;
    yield* Console.log(fresh.trimEnd());
  }).pipe(Effect.ignore);
};

// A flow as a persona runs it, as the runs module names it.
const refOf = (handle: FlowHandle, persona: Persona) => ({
  repo: handle.repo.settings.name,
  flow: handle.name,
  persona,
});

// Follows a run in this process to its boundary, printing its log as it
// grows: it ends, or it parks, which ends it too.
const followRun = (run: RunView, parked: ReadonlySet<RunId>) =>
  Effect.gen(function* () {
    const tail = tailer(yield* runLogFile(run.id));

    yield* followOwnRun(run, parked, Effect.succeedNone, tail);

    const current = Option.getOrElse(
      (yield* (yield* RunsQueries).FindRunQuery({ runId: run.id })).run,
      () => run,
    );

    // What the run held was released as it ended (on RunFinished); a release
    // that failed is left to the daemon's sweep, or the next run, to try again.
    const unreleased = yield* (yield* RunsQueries).ListUnreleasedMarkersQuery();

    for (const marker of unreleased.markers.filter((left) => left.runId === current.id)) {
      yield* Console.log(
        `not released: ${marker.name}: ${Option.getOrElse(marker.lastError, () => "")}`,
      );
    }

    return current;
  });

// `persona` picks one for a repo that runs as several; with one, it's that one.
export type RunOptions = {
  readonly repo: string;
  readonly flow: string;
  readonly item: Option.Option<string>;
  readonly fromCheckout: boolean;
  readonly persona: Option.Option<string>;
};

// The persona a person asked for, which must be one of the repo's, or its only one.
export const choosePersona = (repo: EffectiveRepo, wanted: Option.Option<string>) =>
  Effect.gen(function* () {
    const logins = repo.personas.flatMap((own) => Option.toArray(own.persona));

    if (Option.isSome(wanted)) {
      const found = Arr.findFirst(repo.personas, (own) =>
        Option.contains(own.persona, wanted.value),
      );

      if (Option.isNone(found)) {
        const runs = Option.match(Arr.head(logins), {
          onNone: () => "acts as whoever this machine is on GitHub",
          onSome: () => `runs as ${logins.join(", ")}`,
        });

        return yield* new ConfigError({
          message: `${repo.settings.name} doesn't run as ${wanted.value}; it ${runs}`,
        });
      }

      return found.value.persona;
    }

    if (repo.personas.length > 1) {
      return yield* new ConfigError({
        message: `${repo.settings.name} runs as ${logins.join(", ")}; name one with --as`,
      });
    }

    return defaultPersona(repo);
  });

const describeItem = (item: { readonly key: string; readonly title?: string }) =>
  Option.match(Option.fromUndefinedOr(item.title), {
    onNone: () => item.key,
    onSome: (title) => `${item.key} (${title})`,
  });

// The first item this machine may start, past the work the flow left for others.
const firstOf = (items: ReadonlyArray<WorkItem>) =>
  Effect.gen(function* () {
    const routed = Routing.split(items);

    if (routed.elsewhere.length > 0 && routed.mine.length === 0) {
      yield* Console.log(
        `left for others: ${routed.elsewhere.map(Routing.describeElsewhere).join(", ")}; name one with --item to run it here`,
      );
    }

    return Arr.head(routed.mine);
  });

const startFirst = (
  handle: FlowHandle,
  persona: Persona,
  options: RunOptions,
  context: RepoContext,
  parked: ReadonlySet<RunId>,
) =>
  Effect.gen(function* () {
    // Nothing finds a manual flow's work, so a person must name it.
    if (isManual(handle.flow) && Option.isNone(options.item)) {
      return yield* new ConfigError({
        message: nothingNamed(handle.name, handle.flow.start === true),
      });
    }

    const reported = yield* withRepo(context, triggerOf(handle.flow));

    const items = [
      ...reported,
      ...(yield* withRepo(context, unreportedItem(handle.flow, options.item, reported))),
    ].filter((candidate) => candidate.wakeOnly !== true);

    const found = yield* Option.match(options.item, {
      onNone: () => firstOf(items),
      onSome: (key) =>
        Effect.succeed(Option.fromUndefinedOr(items.find((candidate) => candidate.key === key))),
    });

    if (Option.isNone(found)) {
      yield* Console.log(
        Option.match(options.item, {
          onNone: () => "nothing to do: the trigger found no work for this machine",
          onSome: (key) => `the trigger found no item ${key}`,
        }),
      );

      return Option.none<RunView>();
    }

    const run = yield* startOwnRun(refOf(handle, persona), found.value);

    if (Option.isNone(run)) {
      yield* Console.log(`nothing started: another run has ${found.value.key}`);

      return Option.none<RunView>();
    }

    yield* Console.log(
      `started ${run.value.id} (${runLabel(run.value)}) for ${describeItem(found.value)}, log: ${yield* runLogFile(run.value.id)}`,
    );

    return Option.some(yield* followRun(run.value, parked));
  });

// One run now, skipping gates, for the given item or the first the trigger
// finds. A run of the flow a stopped process left running ends as
// interrupted first, and its phase repeats in this one; one a live process
// still runs is refused.
export const runInForeground = (options: RunOptions) =>
  Effect.gen(function* () {
    const machine = yield* loadMachineConfig;
    const enrolled = yield* findEnrolled(machine, options.repo);
    const { flows, repo, tree } = yield* openRepo(machine, enrolled, options.fromCheckout);
    const flow = Option.fromUndefinedOr(flows.get(options.flow));

    if (Option.isNone(flow)) {
      const known = Option.getOrElse(
        Option.liftPredicate([...flows.keys()].join(", "), (names) => names.length > 0),
        () => "none",
      );

      return yield* new ConfigError({
        message: `${repo.settings.name} has no flow named ${options.flow} (flows: ${known})`,
      });
    }

    const origins = yield* Effect.transposeOption(
      Option.map(tree, (from) => flowOrigins(enrolled, from)),
    );

    const handle = flowHandle(
      repo,
      options.flow,
      flow.value,
      Option.map(origins, (originOf) => originOf(options.flow)),
    );

    yield* acquireLock(
      homePaths((yield* Home).root).engineLock,
      `run ${options.flow} --repo ${repo.settings.name}`,
    );
    const persona = yield* choosePersona(repo, options.persona);
    const contexts = yield* buildPersonaContexts(repo, machine);

    const context = yield* yield* Effect.fromOption(servicesFrom(contexts)(persona)).pipe(
      Effect.orDie,
    );

    // The runs this process's engine parked, as it tells them.
    const parked = new Set<RunId>();

    const program = Effect.gen(function* () {
      yield* adoptRuns(repo);

      yield* (yield* RunFlowsCommands).SweepJournalsCommand();

      const left = (yield* (yield* RunsQueries).ListActiveRunsQuery({
        repo: Option.some(repo.settings.name),
        persona: Option.some(persona),
        flow: Option.some(options.flow),
      })).runs;

      for (const unfinished of left) {
        const ended = yield* takeOverLeftRun(unfinished);

        yield* Console.log(
          [
            `ended ${unfinished.id} (${runLabel(unfinished)}) as interrupted: ${Option.getOrElse(ended.run.summary, () => "")}`,
            ...ended.closedSessions.map(
              (session) => `closed its ${session.launcher} session ${session.handle}`,
            ),
            ...ended.leftForPerson,
          ].join("\n"),
        );
      }

      return yield* startFirst(handle, persona, options, context, parked);
    });

    // The modules a process with an engine adds, and the one flow it runs, over
    // this run's own runtime and the engine in this machine's state.db.
    const engine = yield* Layer.build(
      engineRuntime({
        registry: {
          handles: [handle],
          services: (_repo, one) => servicesFrom(contexts)(one),
        },
        flows: [
          flowLayer(handle, servicesFrom(contexts), noHooks, (runId) =>
            Effect.sync(() => {
              parked.add(runId);
            }),
          ),
        ],
        engine: EngineLive,
      }),
    );

    return yield* Effect.provideContext(program, engine);
  }).pipe(Effect.scoped);
