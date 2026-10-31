import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { effect } from "../../../../test/effect-test.ts";
import { RunId } from "../../../kernel/run-id.id.ts";
import { RunLogsClient } from "../domain/ports/clients/run-logs.client.ts";
import { RunRoot } from "../domain/run/run.root.ts";
import { RunLogsClientFake } from "../infrastructure/clients/run-logs.client-fake.ts";
import { RunsRepositoryFake } from "../infrastructure/repositories/runs.repository-fake.ts";
import { pruneRunLogsHandler } from "./prune-run-logs.handler.ts";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");

const LONG_AGO = Date.parse("2026-08-01T00:00:00.000Z");

const run = (id: string, fields: Partial<RunRoot> = {}) =>
  RunRoot.make({
    id: RunId.make(id),
    coreVersion: "1.0.0",
    repo: "demo",
    persona: Option.none(),
    flow: "implement",
    itemKey: "issue-7",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    item: Option.none(),
    executionId: Option.some(`execution-${id}`),
    status: "running",
    currentStep: Option.none(),
    summary: Option.none(),
    startedAt: "2026-08-01T00:00:00.000Z",
    finishedAt: Option.none(),
    ...fields,
  });

const finished = (id: string, at: string, status: RunRoot["status"] = "done") =>
  run(id, { status, summary: Option.some(status), finishedAt: Option.some(at) });

// The logs left, after a prune on the test clock at NOW over these runs in
// state.db and these logs, each last written when `modified` says.
const pruning = (
  runs: ReadonlyArray<RunRoot>,
  modified: Record<string, number>,
  expected: { readonly removed: ReadonlyArray<string>; readonly left: ReadonlyArray<string> },
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);

    const pruned = yield* pruneRunLogsHandler();
    const logs = yield* RunLogsClient;
    const left: Array<string> = [];

    for (const id of Object.keys(modified)) {
      if (Option.isSome(yield* logs.readFrom(RunId.make(id), 0))) {
        left.push(id);
      }
    }

    expect(pruned.removed.map(String).toSorted()).toEqual([...expected.removed]);
    expect(left.toSorted()).toEqual([...expected.left]);

    for (const id of expected.removed) {
      expect(yield* logs.pruned(RunId.make(id))).toBe(true);
    }
  }).pipe(
    Effect.provide([
      RunsRepositoryFake(runs),
      RunLogsClientFake(
        Object.fromEntries(Object.keys(modified).map((id) => [id, `step: implement (${id})\n`])),
        modified,
      ),
      PassThroughUnitOfWork,
      TestClock.layer(),
    ]),
  );

describe("pruneRunLogsHandler", () => {
  effect("removes the log of a run that finished more than 30 days ago, by state.db", () =>
    pruning(
      [
        finished("old", "2026-09-30T11:00:00.000Z"),
        finished("old-failed", "2026-09-01T00:00:00.000Z", "failed"),
        finished("recent", "2026-10-02T00:00:00.000Z"),
      ],
      // Written long ago, all: the run's finish decides, not the file's age.
      { old: LONG_AGO, "old-failed": LONG_AGO, recent: LONG_AGO },
      { removed: ["old", "old-failed"], left: ["recent"] },
    ),
  );

  effect("keeps the log of a run still running, parked or needing attention, however old", () =>
    pruning(
      [
        run("parked", { currentStep: Option.some("await review") }),
        run("active", { currentStep: Option.some("implement") }),
      ],
      { parked: LONG_AGO, active: LONG_AGO },
      { removed: [], left: ["active", "parked"] },
    ),
  );

  effect("removes a log no run has only once it hasn't been written for 30 days", () =>
    pruning(
      [],
      {
        "orphan-old": Date.parse("2026-09-30T11:00:00.000Z"),
        "orphan-new": Date.parse("2026-10-02T00:00:00.000Z"),
      },
      { removed: ["orphan-old"], left: ["orphan-new"] },
    ),
  );

  effect("has nothing to remove when no run has a log", () =>
    pruning([finished("old", "2026-09-01T00:00:00.000Z")], {}, { removed: [], left: [] }),
  );
});
