// `chernabog ci run` as a spoke on a machine (ADR 23, #658), through the real
// CLI against the fake GitHub: the hub has recorded a run in the machine's
// state.db, and hands it over with `--run` and the run as recorded, with its
// item. The spoke runs it in the machine's own home, in a journal of the
// run's own, to its next phase boundary: it takes the item's claim, records
// the phase, lets the claim go (at a park, its hub's ending does), and reports its steps and how its run ended
// in its journal, for the hub to fold into state.db (#661) and end the run
// with once it has exited (#659). It writes nothing to state.db. Its stdin
// is a pipe the hub holds, and it stops when that closes.

import { type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// Takes the issue's claim, says on the issue which run holds it, and records
// the issue's phase. An issue titled "park ..." then parks on `go`; one
// titled "hold ..." holds the run in a long step, so a test can stop it; one
// titled "agent ..." has an agent work on it first.
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
      const { base, branch } = yield* Implement.claim(issue);

      if ((item.title ?? "").startsWith("agent")) {
        const worktree = yield* Implement.prepareWorktree(branch, { base });
        yield* Implement.implementWithAgent(issue, worktree, { base });
      }

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

const decodeEnding = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ status: Schema.String, summary: Schema.String })),
);

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

  // What the hub does: records the run, writes its hand-over to a file, and
  // starts the spoke with a pipe on its stdin. `before` runs once the run is
  // recorded, before the spoke starts.
  const startSpoke = async (title: string, before: () => void = () => {}) => {
    const issue = sandbox.github.addIssue(title, ["spoke"]);
    const item = itemOf(issue, title);

    const { handOver, runId } = sandbox.recordRun("spoke", item);

    const handOverFile = join(sandbox.root, `hand-over-${runId}.json`);
    writeFileSync(handOverFile, handOver);
    before();

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
      "--hand-over-file",
      handOverFile,
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

  // The tags of the reports the spoke wrote in its run's journal, in order.
  const reportTagsOf = (runId: string) => {
    const db = new Database(journalOf(runId), { readonly: true });

    const rows = db.query<{ tag: string }, []>("SELECT tag FROM spoke_reports ORDER BY seq").all();

    db.close();

    return rows.map((row) => row.tag);
  };

  // What state.db's files hold, to tell whether anything wrote them. An empty
  // write-ahead log is none: SQLite leaves one behind a read-only connection
  // to a database in WAL mode, which writes nothing to it.
  const stateFiles = () =>
    ["state.db", "state.db-wal"].map((name) =>
      Option.match(
        Option.filter(
          Option.liftPredicate(join(sandbox.home, name), existsSync),
          (found) => readFileSync(found).length > 0,
        ),
        {
          onNone: () => "none",
          onSome: (found) => Bun.hash(readFileSync(found)).toString(),
        },
      ),
    );

  // The last ending the spoke reported in its run's journal.
  const reportedOf = (runId: string) => {
    const db = new Database(journalOf(runId), { readonly: true });

    const row = db
      .query<{ payload: string }, []>(
        "SELECT payload FROM spoke_reports WHERE tag = 'RunEnded' ORDER BY seq DESC LIMIT 1",
      )
      .get();

    db.close();

    return Option.map(Option.fromNullishOr(row), (found) => decodeEnding(found.payload));
  };

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

  test("runs the hub's run to its end: claim taken, phase recorded, ending reported", async () => {
    const { issue, runId, spoke } = await startSpoke("done in one phase");
    const { code, output } = await spoke.exited;

    expect(output).toContain("done: phase recorded");
    expect(code).toBe(0);
    // The run the hub recorded is the one that held the claim.
    expect(commentsOn(issue)).toContain(`claimed by ${runId}`);
    // Its claim is a marker the run's ending releases, which the hub does
    // once it has ended the run from the spoke's report.
    expect(Option.isSome(sandbox.github.refSha(claimRef(issue)))).toBe(true);
    expect(phasesOf(issue)).toEqual(["handed-off"]);
    // The spoke ends nothing in state.db: the hub ends the run with what it reported.
    expect(reportedOf(runId)).toEqual(Option.some({ status: "done", summary: "phase recorded" }));
    expect(statusOf(runId)).toEqual(Option.some("running"));
    // A spoke takes no engine lock: the hub's is the machine's.
    expect(existsSync(join(sandbox.home, "state.db.lock"))).toBe(false);
  }, 120_000);

  // Its claims are let go by the ending its hub gives the run, after the
  // fold, as its other markers are (#709): the spoke doesn't let go of them.
  test("a run that parks reports its park, leaving its claim to its hub's ending", async () => {
    const { issue, runId, spoke } = await startSpoke("park on go");
    const { code, output } = await spoke.exited;

    expect(output).toContain("parked");
    expect(code).toBe(0);
    expect(phasesOf(issue)).toEqual(["handed-off"]);
    expect(Option.map(reportedOf(runId), (said) => said.status)).toEqual(
      Option.some("ended-at-park"),
    );
    expect(output).not.toContain("let go of the claim");
    expect(Option.isSome(sandbox.github.refSha(claimRef(issue)))).toBe(true);
  }, 120_000);

  test("writes nothing to state.db: its records are reports in its journal, for the hub", async () => {
    let before: Array<string> = [];

    // An agent call reads its session's token cursor, the one read a spoke
    // makes of state.db, read-only.
    const { runId, spoke } = await startSpoke("agent works on it", () => {
      before = stateFiles();
    });

    const { code, output } = await spoke.exited;

    expect(output).toContain("done: phase recorded");
    expect(code).toBe(0);
    expect(stateFiles()).toEqual(before);
    // What the hub folds: the steps the run took, the claim it held and what
    // the agent call spent, then how the run ended.
    const tags = reportTagsOf(runId);
    expect(tags).toContain("EnterStepCommand");
    expect(tags).toContain("FinishStepCommand");
    expect(tags).toContain("HoldMarkerCommand");
    expect(tags).toContain("RecordTokenUsageCommand");
    expect(tags.at(-1)).toBe("RunEnded");
    expect(statusOf(runId)).toEqual(Option.some("running"));
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

  test("refuses a run handed over with no hand-over, or one that isn't of the run or item named", async () => {
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
    expect(missing.output).toContain("needs the hub's hand-over");

    const { handOver, runId } = sandbox.recordRun("spoke", itemOf(900, "never started"));

    const handedOver = (run: string, item: string) =>
      sandbox.runCli([
        "ci",
        "run",
        "--run",
        run,
        "--repo",
        "demo",
        "--flow",
        "spoke",
        "--persona",
        "chernabog-bot",
        "--item",
        item,
        "--hand-over",
        handOver,
      ]);

    const otherItem = await handedOver(runId, "issue-1");

    expect(otherItem.code).not.toBe(0);
    expect(otherItem.output).toContain("isn't the item handed over");

    const otherRun = await handedOver("00000000-0000-4000-8000-000000000000", "issue-900");

    expect(otherRun.code).not.toBe(0);
    expect(otherRun.output).toContain("isn't the run handed over");
  }, 60_000);
});
