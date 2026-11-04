import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunMarkerRoot } from "../domain/run-marker/run-marker.root.ts";
import { RunLeases } from "../domain/schedule/lease.value-object.ts";
import { type FakeFlow, FlowsClientFake } from "../infrastructure/clients/flows.client-fake.ts";
import { RunMarkersRepositoryFake } from "../infrastructure/repositories/run-markers.repository-fake.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { checkRunLeasesHandler } from "./check-run-leases.handler.ts";

const work = { key: "issue-7", data: { issue: 7 } };

const run = (id: string, fields: Partial<RunRoot> = {}) =>
  RunRoot.make({
    id: RunId.make(id),
    coreVersion: "1.0.0",
    repo: "demo",
    persona: Option.some("bob"),
    flow: "implement",
    itemKey: "issue-7",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    item: Option.some(work),
    executionId: Option.some(`execution-${id}`),
    status: "running",
    currentStep: Option.some("implement"),
    summary: Option.none(),
    startedAt: "2026-10-20T00:00:00.000Z",
    finishedAt: Option.none(),
    ...fields,
  });

const CLAIM_REF = "chernabog/claim-ref";

const marker = (runId: string, name: string, args: Readonly<Record<string, string>>) =>
  RunMarkerRoot.make({
    runId: RunId.make(runId),
    name,
    args,
    keepOn: [],
    status: "held",
    heldAt: "2026-10-20T00:00:00.000Z",
    attempts: 0,
    lastError: Option.none(),
    nextAttemptAt: Option.none(),
    settledAt: Option.none(),
  });

const claimOf = (runId: string, item = "issue-7") => marker(runId, CLAIM_REF, { item, runId });

const runtime = (
  runs: ReadonlyArray<RunRoot>,
  markers: ReadonlyArray<RunMarkerRoot>,
  flow: FakeFlow,
) =>
  Layer.mergeAll(
    RunsRepositoryFake(runs),
    RunMarkersRepositoryFake(markers),
    FlowsClientFake({ "demo/implement": flow }),
  );

const checking = (id: string, renew = Option.none<Duration.Duration>()) =>
  checkRunLeasesHandler({ runId: RunId.make(id), renew });

const HELD = {
  status: "held",
  expiresAt: Option.some("2026-10-21T00:00:00.000Z"),
  renewedAt: Option.some("2026-10-20T12:00:00.000Z"),
} as const;

describe("checkRunLeasesHandler", () => {
  const asks: NonNullable<FakeFlow["leaseAsks"]> = [];

  effect("renews each claim the run holds, as the run, for the time asked", () =>
    Effect.gen(function* () {
      const found = yield* checking("a", Option.some(Duration.hours(2)));

      expect(found).toEqual(
        RunLeases.cases.Held.make({
          leases: [
            { item: "issue-7", expiresAt: HELD.expiresAt, renewedAt: HELD.renewedAt },
            { item: "pr-9", expiresAt: HELD.expiresAt, renewedAt: HELD.renewedAt },
          ],
        }),
      );
      expect(asks).toEqual([
        { runId: "a", item: "issue-7", renew: Option.some(Duration.hours(2)) },
        { runId: "a", item: "pr-9", renew: Option.some(Duration.hours(2)) },
      ]);
    }).pipe(
      Effect.provide([
        runtime(
          [run("a")],
          [
            claimOf("a"),
            marker("a", "chernabog/label", { item: "x", runId: "a" }),
            claimOf("a", "pr-9"),
          ],
          { items: [], leases: { "issue-7": HELD, "pr-9": HELD }, leaseAsks: asks },
        ),
        PassThroughUnitOfWork,
      ]),
    ),
  );

  effect("says a claim another run took over is lost, and how", () =>
    Effect.gen(function* () {
      expect(yield* checking("a")).toEqual(
        RunLeases.cases.Lost.make({ item: "issue-7", reason: "alice's run b took issue-7 over" }),
      );
    }).pipe(
      Effect.provide([
        runtime([run("a")], [claimOf("a")], {
          items: [],
          leases: { "issue-7": { status: "lost", reason: "alice's run b took issue-7 over" } },
        }),
        PassThroughUnitOfWork,
      ]),
    ),
  );

  effect("passes over a claim nobody holds, and a failed check loses nothing", () =>
    Effect.gen(function* () {
      expect(yield* checking("a")).toEqual(RunLeases.cases.Held.make({ leases: [] }));
      expect(yield* checking("b")).toEqual(
        RunLeases.cases.CheckFailed.make({ message: "rate limited" }),
      );
    }).pipe(
      Effect.provide([
        Layer.mergeAll(
          RunsRepositoryFake([run("a"), run("b", { flow: "flaky" })]),
          RunMarkersRepositoryFake([claimOf("a"), claimOf("b")]),
          FlowsClientFake({
            "demo/implement": { items: [] },
            "demo/flaky": { items: [], leaseFails: "rate limited" },
          }),
        ),
        PassThroughUnitOfWork,
      ]),
    ),
  );

  const queueAsks: NonNullable<FakeFlow["leaseAsks"]> = [];

  effect("renews a flow's own marker that declares a lease, beside the claim", () =>
    Effect.gen(function* () {
      const found = yield* checking("a", Option.some(Duration.hours(2)));

      expect(found).toEqual(
        RunLeases.cases.Held.make({
          leases: [
            { item: "issue-7", expiresAt: HELD.expiresAt, renewedAt: HELD.renewedAt },
            { item: "queue-lease", expiresAt: HELD.expiresAt, renewedAt: HELD.renewedAt },
          ],
        }),
      );
      expect(queueAsks.map((ask) => ask.item)).toEqual(["issue-7", "queue-lease"]);
    }).pipe(
      Effect.provide([
        runtime([run("a")], [claimOf("a"), marker("a", "queue-lease", { job: "J-1" })], {
          items: [],
          leased: [CLAIM_REF, "queue-lease"],
          leases: { "issue-7": HELD, "queue-lease": HELD },
          leaseAsks: queueAsks,
        }),
        PassThroughUnitOfWork,
      ]),
    ),
  );

  effect("says a flow's own marker whose renewal reports lost is lost, and why", () =>
    Effect.gen(function* () {
      expect(yield* checking("a", Option.some(Duration.hours(2)))).toEqual(
        RunLeases.cases.Lost.make({ item: "queue-lease", reason: "the queue gave J-1 away" }),
      );
    }).pipe(
      Effect.provide([
        runtime([run("a")], [marker("a", "queue-lease", { job: "J-1" })], {
          items: [],
          leased: ["queue-lease"],
          leases: { "queue-lease": { status: "lost", reason: "the queue gave J-1 away" } },
        }),
        PassThroughUnitOfWork,
      ]),
    ),
  );

  const untilFailure: NonNullable<FakeFlow["leaseAsks"]> = [];

  effect("a lease it can't renew leaves the rest renewed, and loses nothing", () =>
    Effect.gen(function* () {
      expect(yield* checking("a", Option.some(Duration.hours(2)))).toEqual(
        RunLeases.cases.CheckFailed.make({ message: "reading the lease on queue-lease failed" }),
      );
      expect(untilFailure.map((ask) => ask.item)).toEqual(["queue-lease", "issue-7"]);
    }).pipe(
      Effect.provide([
        runtime([run("a")], [marker("a", "queue-lease", { job: "J-1" }), claimOf("a")], {
          items: [],
          leased: [CLAIM_REF, "queue-lease"],
          leases: { "issue-7": HELD },
          leaseFailsOn: "queue-lease",
          leaseAsks: untilFailure,
        }),
        PassThroughUnitOfWork,
      ]),
    ),
  );

  const neverAsked: NonNullable<FakeFlow["leaseAsks"]> = [];

  effect("never renews a marker that declares no lease", () =>
    Effect.gen(function* () {
      const found = yield* checking("a", Option.some(Duration.hours(2)));

      expect(found._tag).toBe("Unchecked");
      expect(neverAsked).toEqual([]);
    }).pipe(
      Effect.provide([
        runtime([run("a")], [marker("a", "tracker-in-progress", { key: "T-1" })], {
          items: [],
          leaseAsks: neverAsked,
        }),
        PassThroughUnitOfWork,
      ]),
    ),
  );

  effect("checks nothing for a run that ended, has no execution, or holds no claim", () =>
    Effect.gen(function* () {
      const tags = [];

      for (const id of ["ended", "unexecuted", "unclaimed", "unknown"]) {
        tags.push((yield* checking(id))._tag);
      }

      expect(tags).toEqual(["Unchecked", "Unchecked", "Unchecked", "Unchecked"]);
    }).pipe(
      Effect.provide([
        runtime(
          [
            run("ended", { status: "done", finishedAt: Option.some("2026-10-21T00:00:00Z") }),
            run("unexecuted", { executionId: Option.none() }),
            run("unclaimed"),
          ],
          [claimOf("ended"), claimOf("unexecuted"), claimOf("someone-else")],
          { items: [], leases: { "issue-7": HELD } },
        ),
        PassThroughUnitOfWork,
      ]),
    ),
  );
});
