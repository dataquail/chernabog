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
import {
  CancelledRun,
  CancelTarget,
  type EndAs,
} from "../domain/run/cancelled-run.value-object.ts";
import { type CleanupFailed, RunAlreadyFinished, RunNotFound } from "../domain/run/run.errors.ts";
import { type RunRoot } from "../domain/run/run.root.ts";
import { RunRootOps } from "../domain/run/run.root-ops.ts";
import { RunView } from "../domain/run/run-view.value-object.ts";
import { claimOf, itemTarget } from "../domain/run/work-item.value-object.ts";
import { type CancelRunPayload } from "./cancel-run.command.ts";

// How long cancel waits for an interrupted workflow to stop: ten seconds.
const STOPPING = { schedule: Schedule.spaced("250 millis"), times: 40 };

const endedAs = (found: RunRoot, endAs: EndAs, at: string) => {
  if (endAs.ending === "needs-human") {
    return RunRootOps.finish(found, "needs-human", endAs.reason, at);
  }

  return RunRootOps.supersede(found, endAs.reason, at, endAs.ending);
};

// What the run's log says of its ending.
const noteOf = (ended: RunRoot) => {
  const summary = Option.getOrElse(ended.summary, () => ended.status);

  if (ended.status === "superseded" || ended.status === "lost") {
    return `${ended.status}: ${summary}`;
  }

  return summary;
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

// Deletes the claim ref on the run's issue or pull request when it names the
// run: the refs it deleted, and what it couldn't, for a person.
const releaseClaimRefs = (run: RunRoot, leftForPerson: Array<string>) =>
  Effect.gen(function* () {
    const cleanup = yield* RunCleanupClient;
    const released: Array<string> = [];

    for (const target of Option.toArray(itemTarget(run.itemKey))) {
      const release = yield* cleanup.releaseClaimRef(run, claimOf(target)).pipe(Effect.result);

      if (Result.isFailure(release)) {
        leftForPerson.push(
          `deleting its claim ref on ${claimOf(target)} failed: ${release.failure.message}`,
        );
      }

      for (const ref of Option.toArray(Option.flatten(Result.getSuccess(release)))) {
        released.push(ref);
      }
    }

    return released;
  });

// Releases a cancelled run's claim on its issue, if its item is one: the
// assignment, and its branch unless the branch holds work, which is said.
// Labels are the flow's, and its markers release them.
const releaseIssueClaim = (cancelled: RunRoot, leftForPerson: Array<string>) =>
  Effect.gen(function* () {
    const cleanup = yield* RunCleanupClient;
    let released = Option.none<{ issue: number; deletedBranch: Option.Option<string> }>();
    const issue = Option.filter(itemTarget(cancelled.itemKey), (item) => item.kind === "issue");

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

    return released;
  });

// A run that has ended keeps its ending, but a flow that never let its claim
// go (one baked before claims were refs) leaves the claim ref behind, which
// would hold the issue or pull request for good. Cancelling it deletes that
// ref and nothing else; with no ref to delete, it fails as before.
const releaseEnded = (found: RunRoot) =>
  Effect.gen(function* () {
    const leftForPerson: Array<string> = [];
    const releasedClaims = yield* releaseClaimRefs(found, leftForPerson);

    if (releasedClaims.length === 0 && leftForPerson.length === 0) {
      return yield* new RunAlreadyFinished({ runId: found.id, status: found.status });
    }

    return CancelledRun.make({
      run: RunView.make({ ...found }),
      alreadyEnded: true,
      stopped: true,
      wakesCleared: 0,
      removedWorktrees: [],
      releasedClaims,
      released: Option.none(),
      closedSessions: [],
      openSessions: [],
      leftForPerson,
    });
  });

export const cancelRunHandler = Effect.fn("cancelRunHandler")(function* ({
  target,
  ...options
}: CancelRunPayload) {
  const runs = yield* RunsRepository;
  const waits = yield* RunWaitsRepository;
  const workflows = yield* WorkflowsClient;
  const cleanup = yield* RunCleanupClient;
  const found = yield* named(target);

  if (found.status !== "running" && Option.isNone(options.endAs)) {
    return yield* releaseEnded(found);
  }

  const at = DateTime.formatIso(yield* DateTime.now);

  const cancelled = yield* Effect.fromResult(
    Option.match(options.endAs, {
      onNone: () => RunRootOps.cancel(found, options.by, at),
      onSome: (endAs) => endedAs(found, endAs, at),
    }),
  );

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

  yield* workflows.note(found.id, noteOf(cancelled));

  const leftForPerson: Array<string> = [];

  // A run that lost its item leaves everything on it, worktree included, to
  // the run that took it over, and for a person to look at.
  if (cancelled.status === "lost") {
    return CancelledRun.make({
      run: RunView.make({ ...cancelled }),
      alreadyEnded: false,
      stopped,
      wakesCleared: parked.length,
      removedWorktrees: [],
      releasedClaims: [],
      released: Option.none(),
      closedSessions: [],
      openSessions: yield* cleanup.openSessions(cancelled),
      leftForPerson,
    });
  }

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

  // The claim ref goes first: it is what holds the issue or pull request.
  const releasedClaims = yield* releaseClaimRefs(cancelled, leftForPerson);
  const released = yield* releaseIssueClaim(cancelled, leftForPerson);

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
    alreadyEnded: false,
    stopped,
    wakesCleared: parked.length,
    removedWorktrees: worktrees.removed,
    releasedClaims,
    released,
    closedSessions,
    openSessions,
    leftForPerson,
  });
});
