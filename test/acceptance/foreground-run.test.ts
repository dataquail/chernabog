// The foreground `chernabog run`, through the real CLI against the fake
// GitHub, as its own hub (ADR 23, decision 9, #665): the run executes in the
// process, in a journal of its own, which the process folds into its
// state.db. A run that parks ends there, as under the daemon, and the command
// returns rather than wait inside the process for a signal. A run of the flow
// that a stopped process left running ends as interrupted, and its phase
// repeats in the new run; one that a live process still owns is refused, so
// two processes never run one run.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { openSandbox, type Sandbox } from "./sandbox.ts";

// Takes the issue's claim and records its phase; an issue titled "park ..."
// parks on `go`, recording `waiting`, the first time.
const PARKING = `import { activity, Claims, defineFlow, GitHub, Implement, Phases, reportAs } from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export default defineFlow({
  trigger: Effect.gen(function* () {
    const issues = yield* (yield* GitHub).queuedIssuesLabelled("fg");

    return issues.map((issue) => Implement.issueItem(issue));
  }).pipe(reportAs("trigger")),
  workflow: (item) =>
    Effect.gen(function* () {
      yield* activity("claim", Claims.acquire(item.key).pipe(Effect.asVoid));

      const before = yield* Phases.current(item.key);

      if ((item.title ?? "").startsWith("park") && Option.isNone(before)) {
        yield* activity("record-phase", Phases.record(item.key, "working"));
        yield* Phases.park({ step: "park", item: item.key, phase: "waiting", data: {} }, ["go"], "go");
      }

      return "worked";
    }),
});
`;

// The run statuses state.db holds, oldest first.
const statuses = (sandbox: Sandbox) => {
  const db = new Database(join(sandbox.home, "state.db"), { readonly: true });
  const rows = db.query("SELECT status FROM om_runs ORDER BY started_at").all();

  db.close();

  return Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ status: Schema.String })))(rows).map(
    (row) => row.status,
  );
};

// When the OS says a process started, as `ps` prints it and chernabog keeps it.
const startOf = (pid: number) =>
  spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  })
    .stdout.trim()
    .replace(/ +/g, " ");

// Records `pid` as the process that runs `runId`, as a run's own hub or a
// daemon's spoke records itself.
const ownedBy = (sandbox: Sandbox, runId: string, pid: number) => {
  const db = new Database(join(sandbox.home, "state.db"));

  db.run(
    "INSERT INTO om_spokes (run_id, pid, started_at, hub_pid, hub_started_at, folded_seq, ending) VALUES (?, ?, ?, ?, ?, 0, NULL)",
    [runId, pid, startOf(pid), pid, startOf(pid)],
  );
  db.close();
};

describe("the foreground run as its own hub", () => {
  let owner: Option.Option<ChildProcess> = Option.none();

  afterEach(() => {
    for (const child of Option.toArray(owner)) {
      child.kill("SIGKILL");
    }

    owner = Option.none();
  });

  const sandboxFor = () =>
    openSandbox({}, { flows: { fg: {} }, recipes: [], repoFiles: { "flows/fg.ts": PARKING } });

  test("a run that parks ends at its park, and the command returns", async () => {
    const sandbox = sandboxFor();
    sandbox.github.addIssue("park until go", ["fg"]);

    const { code, output } = await sandbox.runCli(["run", "fg", "--repo", "demo"]);

    expect(code).toBe(0);
    expect(output).toContain("started ");
    expect(statuses(sandbox)).toEqual(["ended-at-park"]);
  }, 60_000);

  test("a run a live process still owns is refused, and one whose process stopped ends as interrupted", async () => {
    const sandbox = sandboxFor();
    sandbox.github.addIssue("work it", ["fg"]);
    const { runId } = sandbox.recordRun("fg", { key: "issue-1", data: {}, title: "work it" });

    const live = spawn("sleep", ["60"]);
    owner = Option.some(live);
    ownedBy(sandbox, runId, live.pid ?? 0);

    const refused = await sandbox.runCli(["run", "fg", "--repo", "demo"]);

    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain("is still running in process");
    expect(statuses(sandbox)).toEqual(["running"]);

    live.kill("SIGKILL");
    await new Promise((resolve) => live.on("close", resolve));
    owner = Option.none();

    const taken = await sandbox.runCli(["run", "fg", "--repo", "demo"]);

    expect(taken.code).toBe(0);
    expect(taken.output).toContain("as interrupted");
    expect(statuses(sandbox)).toEqual(["interrupted", "done"]);
  }, 90_000);
});
