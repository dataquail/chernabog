import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

import { RunId, runLabel, shortRunId } from "../../../kernel/run-id.id.ts";
import {
  type OpenSession,
  RunCleanupClient,
  type WorktreeCleanup,
} from "../domain/ports/clients/run-cleanup.client.ts";
import { RunLogsClient } from "../domain/ports/clients/run-logs.client.ts";
import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { RunWaitsRepository } from "../domain/ports/repositories/run-waits.repository.ts";
import { RunsRepository } from "../domain/ports/repositories/runs.repository.ts";
import { type CleanupFailed, RunNotFound } from "../domain/run/run.errors.ts";
import { type RunRoot } from "../domain/run/run.root.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { itemTarget } from "../domain/run/work-item.value-object.ts";
import { CancelledRun, CancelTarget } from "./cancel-run.result.ts";
import { RunView } from "./run.result.ts";

// How long cancel waits for an interrupted workflow to stop: ten seconds.
const STOPPING = { schedule: Schedule.spaced("250 millis"), times: 40 };

export type CancelOptions = {
  // Who cancels it, for its summary.
  readonly by: string;
  // Whether to close the agent sessions it left open, by their launcher's
  // handle; otherwise they're left for the person.
  readonly closeSessions: boolean;
};

// The run a prefix names among every run with a log.
const namedAmongAll = (asked: string) =>
  RunLogsClient.use((logs) => logs.ids).pipe(
    Effect.flatMap((ids) => Effect.fromResult(RunRootOps.named(ids, asked))),
  );

// The run a person names: by its item, or by its id or a prefix of it, which
// names a running run before any other, so a prefix ambiguous only among
// finished runs still names it.
const named = (target: CancelTarget) =>
  Effect.gen(function* () {
    const runs = yield* RunsRepository;
    const running = yield* runs.findAll({ running: true });

    if (CancelTarget.guards.ByItem(target)) {
      return yield* Effect.fromResult(RunRootOps.inFlightFor(running, target));
    }

    const exact = yield* runs.findOne(RunId.make(target.asked));

    if (Option.isSome(exact)) {
      return exact.value;
    }

    const inFlight = RunRootOps.named(
      running.map((run) => run.id),
      target.asked,
    );

    const id = yield* Result.match(inFlight, {
      onSuccess: (inFlightId) => Effect.succeed(inFlightId),
      onFailure: () => namedAmongAll(target.asked),
    });

    return yield* Effect.flatMap(runs.findOne(id), (found) =>
      Effect.fromOption(found).pipe(Effect.mapError(() => new RunNotFound({ runId: id }))),
    );
  });

const describeFailure = (what: string) => (failure: CleanupFailed) =>
  Effect.succeed(`${what}: ${failure.message}`);

// Waits, a while, for an interrupted workflow to stop; whether it has.
const stopping = (run: RunRoot, executionId: string) =>
  WorkflowsClient.use((workflows) =>
    workflows.poll({ repo: run.repo, flow: run.flow, persona: run.persona }, executionId),
  ).pipe(Effect.repeat({ ...STOPPING, until: Option.isSome }), Effect.map(Option.isSome));

// Ends a run in flight for good: records it cancelled, by whom and when,
// before its workflow could record anything else; forgets its waits;
// interrupts its workflow, which the engine keeps across a restart; and then
// cleans up what it held: its worktrees, its claim on its issue, and, if asked,
// its agent sessions. What cleaning up can't do is left for a person, and said;
// it never undoes the cancel. Pull requests are never touched.
export const cancelRunUseCase = Effect.fn("cancelRunUseCase")(function* (
  target: CancelTarget,
  options: CancelOptions,
) {
  const runs = yield* RunsRepository;
  const waits = yield* RunWaitsRepository;
  const workflows = yield* WorkflowsClient;
  const cleanup = yield* RunCleanupClient;
  const found = yield* named(target);
  const at = DateTime.formatIso(yield* DateTime.now);
  const cancelled = yield* Effect.fromResult(RunRootOps.cancel(found, options.by, at));
  yield* runs.save(cancelled);

  const parked = yield* waits.findAll(Option.some(found.id));

  for (const wait of parked) {
    yield* waits.remove(wait);
  }

  const flow = { repo: found.repo, flow: found.flow, persona: found.persona };
  let stopped = Option.isNone(found.executionId);

  for (const executionId of Option.toArray(found.executionId)) {
    yield* workflows.interrupt(flow, executionId);

    if (workflows.runs(flow)) {
      stopped = yield* stopping(found, executionId);
    }
  }

  yield* workflows.note(
    found.id,
    Option.getOrElse(cancelled.summary, () => "cancelled"),
  );

  const leftForPerson: Array<string> = [];

  // Worktrees another run in flight on the same issue or pull request may be
  // using stay, for the last run on it, or a person, to remove.
  const sharing = RunRootOps.sharingTarget(yield* runs.findAll({ running: true }), cancelled);

  for (const other of sharing) {
    leftForPerson.push(
      `kept its worktrees: run ${shortRunId(other.id)} (${runLabel(other)}) is in flight on the same item`,
    );
  }

  const removing = Option.liftPredicate(cancelled, () => sharing.length === 0);

  const worktrees = yield* Option.match(removing, {
    onNone: (): Effect.Effect<WorktreeCleanup, CleanupFailed> =>
      Effect.succeed({ removed: [], kept: [] }),
    onSome: (run) => cleanup.removeWorktrees(run),
  }).pipe(
    Effect.catch((failure) =>
      describeFailure("removing its worktrees failed")(failure).pipe(
        Effect.map((said) => {
          leftForPerson.push(said);

          return { removed: [], kept: [] };
        }),
      ),
    ),
  );

  for (const kept of worktrees.kept) {
    leftForPerson.push(`kept worktree ${kept.path}: ${kept.reason}`);
  }

  let released = Option.none<{ issue: number; deletedBranch: Option.Option<string> }>();
  const issue = Option.filter(itemTarget(found.itemKey), (item) => item.kind === "issue");

  for (const { number } of Option.toArray(issue)) {
    const release = yield* cleanup.releaseClaim(cancelled, number).pipe(Effect.result);

    if (Result.isFailure(release)) {
      leftForPerson.push(`releasing its claim on #${number} failed: ${release.failure.message}`);
    }

    for (const { branch, kept } of Option.toArray(Option.flatten(Result.getSuccess(release)))) {
      released = Option.some({
        issue: number,
        deletedBranch: Option.liftPredicate(branch, () => Option.isNone(kept)),
      });

      for (const reason of Option.toArray(kept)) {
        leftForPerson.push(`kept branch ${branch}: ${reason}`);
      }
    }
  }

  const sessions = yield* cleanup.openSessions(cancelled);
  const closedSessions: Array<OpenSession> = [];
  const openSessions: Array<OpenSession> = [];

  for (const session of sessions) {
    if (!options.closeSessions) {
      openSessions.push(session);
      continue;
    }

    const closing = yield* cleanup.closeSession(session).pipe(Effect.result);

    if (Result.isSuccess(closing)) {
      closedSessions.push(session);
    } else {
      openSessions.push(session);
      leftForPerson.push(
        `closing ${session.launcher} session ${session.handle} failed: ${closing.failure.message}`,
      );
    }
  }

  return CancelledRun.make({
    run: RunView.make({ ...cancelled }),
    stopped,
    wakesCleared: parked.length,
    removedWorktrees: worktrees.removed,
    released,
    closedSessions,
    openSessions,
    leftForPerson,
  });
});
