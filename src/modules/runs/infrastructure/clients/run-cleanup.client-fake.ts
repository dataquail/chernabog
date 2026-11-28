import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import {
  type LabelledContainer,
  type OpenSession,
  type ReleasedClaim,
  RunCleanupClient,
  type WorktreeCleanup,
} from "../../domain/ports/clients/run-cleanup.client.ts";
import { CleanupFailed } from "../../domain/run/run.errors.ts";

// What a test's runs hold, by run id, and what cleaning up did: the
// worktrees each run's cleanup finds, the claim it releases, if any, the claim
// refs that name it (`issue-<n>`, `pr-<n>`), the sessions it has open, the
// labelled containers on each runtime, and the runs and issues cleaned up, the
// refs deleted, sessions closed and containers removed, each by its id, in the
// order `events` records with what else cleaning up did. A run listed in
// `failing` fails every cleanup but its containers' with its message, and a
// runtime in `failingRuntimes` every listing and removal on it.
export type FakeHoldings = {
  readonly worktrees: Record<string, WorktreeCleanup>;
  readonly claims: Record<string, ReleasedClaim>;
  readonly claimRefs: Record<string, ReadonlyArray<string>>;
  readonly sessions: Record<string, ReadonlyArray<OpenSession>>;
  readonly failing: Record<string, string>;
  readonly cleaned: Array<string>;
  readonly released: Array<number>;
  readonly deletedRefs: Array<string>;
  readonly closed: Array<string>;
  readonly containers: Array<LabelledContainer>;
  readonly failingRuntimes: Record<string, string>;
  readonly removedContainers: Array<string>;
  readonly events: Array<string>;
};

export const fakeHoldings = (held: Partial<FakeHoldings> = {}): FakeHoldings => ({
  worktrees: {},
  claims: {},
  claimRefs: {},
  sessions: {},
  failing: {},
  cleaned: [],
  released: [],
  deletedRefs: [],
  closed: [],
  containers: [],
  failingRuntimes: {},
  removedContainers: [],
  events: [],
  ...held,
});

export const RunCleanupClientFake = (holdings: FakeHoldings) => {
  const failure = (runId: string) =>
    Option.match(Record.get(holdings.failing, runId), {
      onNone: () => Effect.void,
      onSome: (message) => Effect.fail(new CleanupFailed({ message })),
    });

  const runtimeFailure = (runtime: string) =>
    Option.match(Record.get(holdings.failingRuntimes, runtime), {
      onNone: () => Effect.void,
      onSome: (message) => Effect.fail(new CleanupFailed({ message })),
    });

  const remove = (container: LabelledContainer) => {
    const at = holdings.containers.indexOf(container);

    if (at >= 0) {
      holdings.containers.splice(at, 1);
    }

    holdings.removedContainers.push(container.id);
    holdings.events.push(`removed ${container.id}`);
  };

  return Layer.succeed(
    RunCleanupClient,
    RunCleanupClient.of({
      removeWorktrees: (run) =>
        failure(run.id).pipe(
          Effect.andThen(
            Effect.sync(() => {
              holdings.cleaned.push(run.id);
              holdings.events.push(`removed the worktrees of ${run.id}`);

              return Option.getOrElse(
                Record.get(holdings.worktrees, run.id),
                (): WorktreeCleanup => ({ removed: [], kept: [] }),
              );
            }),
          ),
        ),
      releaseClaimRef: (run, claim) =>
        failure(run.id).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const held = Option.getOrElse(
                Record.get(holdings.claimRefs, run.id),
                (): ReadonlyArray<string> => [],
              );

              if (!held.includes(claim) || holdings.deletedRefs.includes(claim)) {
                return Option.none<string>();
              }

              holdings.deletedRefs.push(claim);

              return Option.some(`refs/chernabog/claims/${claim}`);
            }),
          ),
        ),
      releaseClaim: (run, issue) =>
        failure(run.id).pipe(
          Effect.andThen(
            Effect.sync(() => {
              holdings.released.push(issue);

              return Record.get(holdings.claims, run.id);
            }),
          ),
        ),
      openSessions: (run) =>
        Effect.sync(() => Option.getOrElse(Record.get(holdings.sessions, run.id), () => [])),
      openReported: (sessions) =>
        Effect.sync(() =>
          Object.values(holdings.sessions)
            .flat()
            .filter((open) => sessions.some((reported) => reported.sessionId === open.sessionId)),
        ),
      closeSession: (session) =>
        Effect.sync(() => {
          holdings.closed.push(session.handle);
          holdings.events.push(`closed ${session.handle}`);
        }),
      removeContainers: (run, sparing) =>
        Effect.gen(function* () {
          const removing = holdings.containers.filter(
            (container) =>
              container.runId === run.id &&
              !Option.exists(container.sessionId, (sessionId) => sparing.includes(sessionId)),
          );

          for (const container of removing) {
            yield* runtimeFailure(container.runtime);
          }

          for (const container of removing) {
            remove(container);
          }

          return removing;
        }),
      containerRuntimes: Effect.sync(() =>
        [
          ...new Set([
            ...holdings.containers.map((container) => container.runtime),
            ...Object.keys(holdings.failingRuntimes),
          ]),
        ].sort(),
      ),
      labelledContainers: (runtime) =>
        runtimeFailure(runtime).pipe(
          Effect.andThen(
            Effect.sync(() =>
              holdings.containers.filter((container) => container.runtime === runtime),
            ),
          ),
        ),
      removeContainer: (container) =>
        runtimeFailure(container.runtime).pipe(
          Effect.andThen(
            Effect.sync(() => {
              remove(container);
            }),
          ),
        ),
    }),
  );
};
