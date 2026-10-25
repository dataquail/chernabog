// Cancels a run in flight: through the daemon when it is running, otherwise
// in this process, which opens the engine under its lock as `chernabog run`
// does, with every enrolled repo's personas, so the run's cleanup acts as the
// one it ran as.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as References from "effect/References";
import * as Result from "effect/Result";

import { runLabel } from "../../../kernel/run-id.id.ts";
import {
  buildPersonaContexts,
  openRepo,
  type PersonaContext,
  servicesFrom,
} from "../../../modules/runs/infrastructure/runtime/repo-runtime.ts";
import { RuntimeLayer, StateLive } from "../../../modules/runs/runs.layer.ts";
import {
  type CancelledRun,
  CancelTarget,
} from "../../../modules/runs/use-cases/cancel-run.result.ts";
import { cancelRunUseCase } from "../../../modules/runs/use-cases/cancel-run.use-case.ts";
import { userName } from "../../../platform/environment.ts";
import { Home, homePaths } from "../../../platform/home.ts";
import { acquireLock } from "../../../platform/lock.ts";
import { loadMachineConfig, repoNameOf } from "../../../repo-config.ts";
import { daemonCancel } from "../../daemon/daemon.client.ts";

export type CancelArgs = {
  // A run's id or a prefix of it; with `item`, the repo the item is in.
  readonly run: string;
  readonly item: Option.Option<string>;
  readonly flow: Option.Option<string>;
  readonly persona: Option.Option<string>;
  readonly closeSessions: boolean;
};

const targetOf = (args: CancelArgs): CancelTarget =>
  Option.match(args.item, {
    onNone: () => CancelTarget.cases.ById.make({ asked: args.run }),
    onSome: (itemKey) =>
      CancelTarget.cases.ByItem.make({
        repo: args.run,
        itemKey,
        flow: args.flow,
        persona: args.persona,
      }),
  });

// Every enrolled repo this machine can open, with its personas' services, and
// the name its runs know it by, by its name or slug; a repo that won't open
// has none, so cleaning up after its runs says so.
const openEnrolled = Effect.gen(function* () {
  const machine = yield* loadMachineConfig;
  const contexts = new Map<string, ReadonlyArray<PersonaContext>>();
  const names = new Map<string, string>();

  for (const enrolled of machine.repos) {
    const opened = yield* Effect.result(openRepo(machine, enrolled, false));

    if (Result.isSuccess(opened)) {
      const { repo } = opened.success;
      contexts.set(repo.settings.name, yield* buildPersonaContexts(repo, machine));
      names.set(enrolled.repo, repo.settings.name);
      names.set(repoNameOf(enrolled), repo.settings.name);
    }
  }

  return { contexts, names };
});

// The run cancelled in this process, with the daemon stopped.
const cancelHere = (target: CancelTarget, by: string, closeSessions: boolean) =>
  Effect.gen(function* () {
    yield* acquireLock(homePaths((yield* Home).root).engineLock, "cancel");
    const { contexts, names } = yield* openEnrolled;

    const named = CancelTarget.match(target, {
      ById: (byId): CancelTarget => byId,
      ByItem: (byItem): CancelTarget => ({
        ...byItem,
        repo: Option.getOrElse(Option.fromUndefinedOr(names.get(byItem.repo)), () => byItem.repo),
      }),
    });

    const runtime = yield* Layer.build(
      RuntimeLayer({
        handles: [],
        services: (repoName, persona) =>
          Option.flatMap(Option.fromUndefinedOr(contexts.get(repoName)), (personas) =>
            servicesFrom(personas)(persona),
          ),
      }).pipe(
        Layer.provideMerge(StateLive),
        // The engine's storage loop warns, on every pass, of the messages it
        // keeps for workflows this process doesn't load, such as other runs'
        // and the interrupt just stored; the daemon delivers them.
        Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
      ),
    );

    return yield* cancelRunUseCase(named, { by, closeSessions, needsHuman: Option.none() }).pipe(
      Effect.provideContext(runtime),
    );
  }).pipe(Effect.scoped);

// What cancelling did, for a person to read.
export const describeCancelled = (cancelled: CancelledRun): ReadonlyArray<string> => {
  const { run } = cancelled;

  const stopped = Option.match(run.executionId, {
    onNone: () => [],
    onSome: () => {
      if (cancelled.stopped) {
        return ["its workflow stopped in the engine"];
      }

      return ["its workflow is interrupted in the engine, which never resumes it"];
    },
  });

  return [
    `cancelled ${run.id} (${runLabel(run)}): ${Option.getOrElse(run.summary, () => "")}`,
    ...stopped,
    ...Option.toArray(
      Option.liftPredicate(
        `cleared the signals it waited on (${cancelled.wakesCleared})`,
        () => cancelled.wakesCleared > 0,
      ),
    ),
    ...cancelled.removedWorktrees.map((path) => `removed worktree ${path}`),
    ...Option.toArray(
      Option.map(cancelled.released, (released) =>
        Option.match(released.deletedBranch, {
          onNone: () => `released the claim on #${released.issue}`,
          onSome: (branch) =>
            `released the claim on #${released.issue} and deleted branch ${branch}`,
        }),
      ),
    ),
    ...cancelled.closedSessions.map(
      (session) => `closed ${session.launcher} session ${session.handle}`,
    ),
    ...cancelled.openSessions.map(
      (session) =>
        `left ${session.launcher} session ${session.handle} open; close it yourself, or cancel with --close-session`,
    ),
    ...cancelled.leftForPerson.map((line) => `left for you: ${line}`),
  ];
};

// The run cancelled, through the daemon if it's running; a refusal from it is
// the answer, and only a daemon that isn't there cancels here instead.
export const cancelRun = (args: CancelArgs) =>
  Effect.gen(function* () {
    const target = targetOf(args);
    const by = yield* userName;

    const viaDaemon = yield* Effect.result(
      daemonCancel({ target, by, closeSessions: args.closeSessions }),
    );

    if (Result.isSuccess(viaDaemon)) {
      return describeCancelled(viaDaemon.success);
    }

    if (Predicate.isTagged(viaDaemon.failure, "DaemonRefused")) {
      return yield* viaDaemon.failure;
    }

    return describeCancelled(yield* cancelHere(target, by, args.closeSessions));
  });
