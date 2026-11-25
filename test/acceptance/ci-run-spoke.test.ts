// `chernabog ci run` as a spoke on a machine (ADR 23, #658), through the real
// CLI against the fake GitHub: the hub has recorded a run in the machine's
// state.db, and hands it over with `--run` and the item. The spoke runs it in
// the machine's own home, in a journal of the run's own, to its next phase
// boundary: it takes the item's claim, records the phase, lets the claim go,
// and its journal is gone once it exits. Its stdin is a pipe the hub holds,
// and it stops when that closes.

import { type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// Takes the issue's claim, says on the issue which run holds it, and records
// the issue's phase. An issue titled "park ..." then parks on `go`; one
// titled "hold ..." holds the run in a long step, so a test can stop it.
const SPOKE = `import { activity, awaitSignal, Claims, defineFlow, GitHub, Implement, Issue, Phases, reportAs } from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export default defineFlow({
  trigger: Effect.gen(function* () {
    const issues = yield* (yield* GitHub).queuedIssuesLabelled("spoke");

    return issues.map((issue) => Implement.issueItem(issue));
  }).pipe(reportAs("trigger")),
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      yield* Implement.claim(issue);

      const holder = yield* activity(
        "holder",
        Claims.liveHolder(item.key).pipe(
          Effect.map(Option.match({ onNone: () => "nobody", onSome: (found) => found.runId })),
        ),
        Schema.String,
      );

      yield* Issue.comment(issue, \`claimed by \${holder}\`);
      yield* activity("record-phase", Phases.record(item.key, "handed-off"));

      if ((item.title ?? "").startsWith("hold")) {
        yield* activity("hold", Effect.sleep("60 seconds"));
      }

      if ((item.title ?? "").startsWith("park")) {
        yield* awaitSignal(["go"], { id: "park", timeout: "1 day" });
      }

      return "phase recorded";
    }),
});
`;

const claimRef = (issue: number) => `refs/chernabog/claims/issue-${issue}`;

type Spoke = {
  readonly child: ChildProcess;
  readonly exited: Promise<{ readonly code: number; readonly output: string }>;
  readonly output: () => string;
};

describe("chernabog ci run as a spoke on a machine", () => {
  let sandbox: Sandbox;

  // The item the hub hands over, as the trigger reports it.
  const itemOf = (issue: number, title: string) => ({
    key: `issue-${issue}`,
    title,
    url: `https://github.com/dataquail/demo/issues/${issue}`,
    data: { issue },
  });

  // What the hub does: records the run, writes its item to a file, and starts
  // the spoke with a pipe on its stdin.
  const startSpoke = async (title: string) => {
    const issue = sandbox.github.addIssue(title, ["spoke"]);
    const item = itemOf(issue, title);

    const runId = sandbox.recordRun("spoke", item);

    const itemFile = join(sandbox.root, `item-${runId}.json`);
    writeFileSync(itemFile, JSON.stringify(item));

    const child = sandbox.spokeCli([
      "ci",
      "run",
      "--run",
      runId,
      "--repo",
      "demo",
      "--flow",
      "spoke",
      "--persona",
      "chernabog-bot",
      "--item",
      item.key,
      "--work-item-file",
      itemFile,
    ]);

    let output = "";

    const collect = (chunk: Buffer) => {
      output += chunk.toString();
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const exited = new Promise<{ code: number; output: string }>((resolve) => {
      child.on("close", (code) => {
        resolve({ code: code ?? -1, output });
      });
    });

    const spoke: Spoke = { child, exited, output: () => output };

    return { issue, runId, spoke };
  };

  // The run as the machine's state.db has it.
  const statusOf = (runId: string) => {
    const db = new Database(join(sandbox.home, "state.db"), { readonly: true });

    const row = db
      .query<{ status: string }, [string]>("SELECT status FROM om_runs WHERE id = ?")
      .get(runId);

    db.close();

    return Option.map(Option.fromNullishOr(row), (found) => found.status);
  };

  const journalOf = (runId: string) => join(sandbox.home, "journals", `${runId}.db`);

  const phasesOf = (issue: number) =>
    sandbox.github.dispatches
      .filter((sent) => sent.item === `issue-${issue}`)
      .map((sent) => sent.to);

  const commentsOn = (issue: number) =>
    sandbox.github.commentsOn(issue).map((comment) => comment.body);

  beforeAll(() => {
    sandbox = openSandbox({}, { flows: { spoke: {} }, repoFiles: { "flows/spoke.ts": SPOKE } });
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("runs the hub's run to its end: claim taken and let go, phase recorded, journal gone", async () => {
    const { issue, runId, spoke } = await startSpoke("done in one phase");
    const { code, output } = await spoke.exited;

    expect(output).toContain("done: phase recorded");
    expect(code).toBe(0);
    // The run the hub recorded is the one that held the claim.
    expect(commentsOn(issue)).toContain(`claimed by ${runId}`);
    expect(sandbox.github.refSha(claimRef(issue))).toEqual(Option.none());
    expect(phasesOf(issue)).toEqual(["handed-off"]);
    expect(statusOf(runId)).toEqual(Option.some("done"));
    expect(existsSync(journalOf(runId))).toBe(false);
    // A spoke takes no engine lock: the hub's is the machine's.
    expect(existsSync(join(sandbox.home, "state.db.lock"))).toBe(false);
  }, 120_000);

  test("a run that parks ends at its park, letting go of its claim and its journal", async () => {
    const { issue, runId, spoke } = await startSpoke("park on go");
    const { code, output } = await spoke.exited;

    expect(output).toContain("parked");
    expect(code).toBe(0);
    expect(phasesOf(issue)).toEqual(["handed-off"]);
    expect(statusOf(runId)).toEqual(Option.some("ended-at-park"));
    expect(sandbox.github.refSha(claimRef(issue))).toEqual(Option.none());
    expect(existsSync(journalOf(runId))).toBe(false);
  }, 120_000);

  test("another process writing state.db meanwhile only makes the spoke wait", async () => {
    // The daemon's side, for as long as the spoke runs: a write lock taken
    // every 50 ms and held for 200 of them.
    const db = new Database(join(sandbox.home, "state.db"));
    db.run("PRAGMA busy_timeout = 30000");
    db.run("CREATE TABLE IF NOT EXISTS test_second_writer (at TEXT)");
    let writing = true;
    let writes = 0;

    const write = () => {
      if (!writing) {
        return;
      }

      db.run("BEGIN IMMEDIATE");
      db.run("INSERT INTO test_second_writer (at) VALUES (?)", [new Date().toISOString()]);
      writes += 1;

      setTimeout(() => {
        db.run("COMMIT");
        setTimeout(write, 50);
      }, 200);
    };

    const { issue, runId, spoke } = await startSpoke("done beside another writer");
    write();
    const { code, output } = await spoke.exited;
    writing = false;
    await waitFor(() => !db.inTransaction, "the second writer to commit", 5_000);
    db.close();

    expect(output).toContain("done: phase recorded");
    expect(code).toBe(0);
    expect(writes).toBeGreaterThan(1);
    expect(phasesOf(issue)).toEqual(["handed-off"]);
    expect(statusOf(runId)).toEqual(Option.some("done"));
  }, 120_000);

  test("a spoke whose stdin closes stops, letting go of its claim", async () => {
    const { issue, spoke } = await startSpoke("hold until stopped");

    await waitFor(
      () => commentsOn(issue).some((body) => body.startsWith("claimed by")),
      "the spoke to take the claim",
      60_000,
    );
    expect(Option.isSome(sandbox.github.refSha(claimRef(issue)))).toBe(true);

    const stoppedAt = Date.now();
    spoke.child.stdin?.end();
    const { code, output } = await spoke.exited;

    // Stopped as on SIGTERM, well before its 60-second step was done: the
    // program interrupted, which exits 130 whatever signal interrupted it.
    expect(code).toBe(130);
    expect(Date.now() - stoppedAt).toBeLessThan(30_000);
    expect(output).toContain(`let go of the claim on issue-${issue}`);
    expect(sandbox.github.refSha(claimRef(issue))).toEqual(Option.none());
  }, 120_000);

  test("refuses a run handed over with no item, or an item that isn't the one named", async () => {
    const missing = await sandbox.runCli([
      "ci",
      "run",
      "--run",
      "00000000-0000-4000-8000-000000000000",
      "--repo",
      "demo",
      "--flow",
      "spoke",
      "--persona",
      "chernabog-bot",
      "--item",
      "issue-1",
    ]);

    expect(missing.code).not.toBe(0);
    expect(missing.output).toContain("needs the item it is for");

    const mismatched = await sandbox.runCli([
      "ci",
      "run",
      "--run",
      "00000000-0000-4000-8000-000000000000",
      "--repo",
      "demo",
      "--flow",
      "spoke",
      "--persona",
      "chernabog-bot",
      "--item",
      "issue-1",
      "--work-item",
      JSON.stringify(itemOf(2, "another")),
    ]);

    expect(mismatched.code).not.toBe(0);
    expect(mismatched.output).toContain("isn't the item handed over");
  }, 60_000);
});
