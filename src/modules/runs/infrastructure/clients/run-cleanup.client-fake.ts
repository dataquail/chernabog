import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import {
  type OpenSession,
  type ReleasedClaim,
  RunCleanupClient,
  type WorktreeCleanup,
} from "../../domain/ports/clients/run-cleanup.client.ts";
import { CleanupFailed } from "../../domain/run/run.errors.ts";

// What a test's runs hold, by run id, and what cleaning up did: the
// worktrees each run's cleanup finds, the claim it releases, if any, the sessions
// it has open, and the runs and issues cleaned up, and sessions closed. A run
// listed in `failing` fails every cleanup with its message.
export type FakeHoldings = {
  readonly worktrees: Record<string, WorktreeCleanup>;
  readonly claims: Record<string, ReleasedClaim>;
  readonly sessions: Record<string, ReadonlyArray<OpenSession>>;
  readonly failing: Record<string, string>;
  readonly cleaned: Array<string>;
  readonly released: Array<number>;
  readonly closed: Array<string>;
};

export const fakeHoldings = (held: Partial<FakeHoldings> = {}): FakeHoldings => ({
  worktrees: {},
  claims: {},
  sessions: {},
  failing: {},
  cleaned: [],
  released: [],
  closed: [],
  ...held,
});

export const RunCleanupClientFake = (holdings: FakeHoldings) => {
  const failure = (runId: string) =>
    Option.match(Record.get(holdings.failing, runId), {
      onNone: () => Effect.void,
      onSome: (message) => Effect.fail(new CleanupFailed({ message })),
    });

  return Layer.succeed(
    RunCleanupClient,
    RunCleanupClient.of({
      removeWorktrees: (run) =>
        failure(run.id).pipe(
          Effect.andThen(
            Effect.sync(() => {
              holdings.cleaned.push(run.id);

              return Option.getOrElse(
                Record.get(holdings.worktrees, run.id),
                (): WorktreeCleanup => ({ removed: [], kept: [] }),
              );
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
      closeSession: (session) =>
        Effect.sync(() => {
          holdings.closed.push(session.handle);
        }),
    }),
  );
};
