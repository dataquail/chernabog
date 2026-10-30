// One run of a flow in this process, in the foreground, as `chernabog run
// --from-checkout` (or `run` with no daemon) does: opens the repo, builds its
// personas' services and the engine, and resumes or starts a run, following
// its log until it ends.

import { isManual, triggerOf, type WorkItem } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { nothingNamed } from "../../../kernel/manual-flow.value-object.ts";
import { type Persona } from "../../../kernel/persona.value-object.ts";
import { runLabel } from "../../../kernel/run-id.id.ts";
import {
  describeElsewhere,
  routeItems,
} from "../../../modules/runs/domain/routing/routing.value-object.ts";
import { withRepo } from "../../../modules/runs/infrastructure/clients/flows.client-live.ts";
import {
  defaultPersona,
  type FlowHandle,
  flowHandle,
  flowLayer,
  runLogFile,
} from "../../../modules/runs/infrastructure/runtime/engine.ts";
import {
  adoptRuns,
  buildPersonaContexts,
  flowOrigins,
  openRepo,
  type RepoContext,
  servicesFrom,
  unreportedItem,
} from "../../../modules/runs/infrastructure/runtime/repo-runtime.ts";
import {
  RunFlowsCommands,
  RunFlowsCommandsLive,
  RunsCommandsLive,
} from "../../../modules/runs/runs.command-handlers.ts";
import { RuntimeLayer, StateLive } from "../../../modules/runs/runs.layer.ts";
import { RunsQueries, RunsQueriesLive } from "../../../modules/runs/runs.query-handlers.ts";
import { releaseMarkersUseCase } from "../../../modules/runs/use-cases/release-markers.use-case.ts";
import { type ActiveRun, type RunView } from "../../../modules/runs/use-cases/run.result.ts";
import { ConfigError } from "../../../platform/config-error.ts";
import { Home, homePaths } from "../../../platform/home.ts";
import { acquireLock } from "../../../platform/lock.ts";
import { type EffectiveRepo, findEnrolled, loadMachineConfig } from "../../../repo-config.ts";

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

const SIGNAL_EVERY_MS = 60_000;

// A flow as a persona runs it, as the runs module names it.
const refOf = (handle: FlowHandle, persona: Persona) => ({
  repo: handle.repo.settings.name,
  flow: handle.name,
  persona,
});

const followRun = (
  handle: FlowHandle,
  persona: Persona,
  run: RunView | ActiveRun,
  context: RepoContext,
) =>
  Effect.gen(function* () {
    const tail = tailer(yield* runLogFile(run.id));
    let current = run;
    let lastSignalCheck = yield* Clock.currentTimeMillis;

    while (current.status === "running") {
      yield* tail;
      yield* Effect.sleep("1 second");
      current = Option.getOrElse(
        (yield* (yield* RunFlowsCommands).PollRunCommand({ runId: current.id })).run,
        () => current,
      );
      const now = yield* Clock.currentTimeMillis;

      if (now - lastSignalCheck > SIGNAL_EVERY_MS) {
        lastSignalCheck = now;

        const items = yield* withRepo(context, triggerOf(handle.flow)).pipe(
          Effect.orElseSucceed(() => []),
        );

        yield* (yield* RunFlowsCommands).DeliverSignalsCommand({
          flow: refOf(handle, persona),
          items,
        });
      }
    }

    yield* tail;

    // What the run held is released here, as the daemon would; a release
    // that fails is left to the daemon, or the next run, to try again.
    const releases = yield* releaseMarkersUseCase();

    for (const marker of [...releases.failed, ...releases.unreleasable]) {
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

const resume = (
  handle: FlowHandle,
  persona: Persona,
  unfinished: ActiveRun,
  context: RepoContext,
  // Whether its workflow just started, as a start a crash interrupted.
  recovered: boolean,
) =>
  Effect.gen(function* () {
    yield* Console.log(
      `resuming ${unfinished.id} (${runLabel(unfinished)}), log: ${yield* runLogFile(unfinished.id)}`,
    );

    if (!recovered) {
      yield* (yield* RunFlowsCommands).ResumeRunCommand({ runId: unfinished.id });
    }

    return Option.some(yield* followRun(handle, persona, unfinished, context));
  });

// The first item this machine may start, past the work the flow left for others.
const firstOf = (items: ReadonlyArray<WorkItem>) =>
  Effect.gen(function* () {
    const routed = routeItems(items);

    if (routed.elsewhere.length > 0 && routed.mine.length === 0) {
      yield* Console.log(
        `left for others: ${routed.elsewhere.map(describeElsewhere).join(", ")}; name one with --item to run it here`,
      );
    }

    return Arr.head(routed.mine);
  });

const startFirst = (
  handle: FlowHandle,
  persona: Persona,
  options: RunOptions,
  context: RepoContext,
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

    const { run } = yield* (yield* RunFlowsCommands).StartFlowRunCommand({
      flow: refOf(handle, persona),
      item: found.value,
    });

    if (Option.isNone(run)) {
      return Option.none<RunView>();
    }

    yield* Console.log(
      `started ${run.value.id} (${runLabel(run.value)}) for ${describeItem(found.value)}, log: ${yield* runLogFile(run.value.id)}`,
    );

    return Option.some(yield* followRun(handle, persona, run.value, context));
  });

// One run now, skipping gates: resumes the flow's unfinished run in this repo
// if there is one, otherwise starts one for the given item or the first the
// trigger finds.
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

    const program = Effect.gen(function* () {
      yield* adoptRuns(repo);

      const recovered = yield* (yield* RunFlowsCommands).RecoverRunsCommand();

      for (const run of recovered.abandoned) {
        yield* Console.log(
          `ended ${run.id} (${runLabel(run)}): a crash interrupted its start, and it kept no work item to start it from`,
        );
      }

      const unfinished = Arr.head(
        (yield* (yield* RunsQueries).ListActiveRunsQuery({
          repo: Option.some(repo.settings.name),
          persona: Option.some(persona),
          flow: Option.some(options.flow),
        })).runs,
      );

      if (Option.isSome(unfinished)) {
        return yield* resume(
          handle,
          persona,
          unfinished.value,
          context,
          recovered.executed.some((run) => run.id === unfinished.value.id),
        );
      }

      return yield* startFirst(handle, persona, options, context);
    });

    const engine = yield* Layer.build(
      RunFlowsCommandsLive.pipe(
        Layer.provideMerge(
          RuntimeLayer({
            handles: [handle],
            services: (_repo, one) => servicesFrom(contexts)(one),
          }).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                flowLayer(handle, servicesFrom(contexts)),
                RunsQueriesLive,
                RunsCommandsLive,
              ).pipe(Layer.provideMerge(StateLive)),
            ),
          ),
        ),
      ),
    );

    return yield* Effect.provideContext(program, engine);
  }).pipe(Effect.scoped);
