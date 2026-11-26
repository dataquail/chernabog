// Every CLI command writes its spans and logs under the chernabog home's
// telemetry/, in a file of its own process: telemetry/<day>/cli-<pid>.jsonl.

import type { ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { TELEMETRY_RETENTION } from "../../src/platform/retention.ts";
import { closed, openSandbox, type Sandbox, waitFor } from "./sandbox.ts";

// What the test reads of a line, decoded as any reader of the files would.
const TelemetryLine = Schema.Struct({
  type: Schema.Literals(["span", "log"]),
  name: Schema.optional(Schema.String),
  traceId: Schema.optional(Schema.String),
  spanId: Schema.optional(Schema.String),
  parentSpanId: Schema.optional(Schema.String),
  attributes: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
});

type TelemetryRecord = typeof TelemetryLine.Type;

const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(TelemetryLine));

// The records a process wrote, across the day folders it wrote them in.
const recordsOf = (home: string, process: string, pid: number) => {
  const dir = join(home, "telemetry");

  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir)
    .map((day) => join(dir, day, `${process}-${pid}.jsonl`))
    .filter((file) => existsSync(file))
    .flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => decodeLine(line)),
    );
};

const spans = (records: ReadonlyArray<TelemetryRecord>) =>
  records.filter((record) => record.type === "span");

// The span ids from `span` up through its parents, by the parents the records name.
const lineage = (records: ReadonlyArray<TelemetryRecord>, span: TelemetryRecord) => {
  const byId = new Map(spans(records).map((record) => [record.spanId, record]));
  const ids: Array<string> = [];
  let current = Option.some(span);

  while (Option.isSome(current)) {
    for (const id of Option.toArray(Option.fromUndefinedOr(current.value.spanId))) {
      ids.push(id);
    }

    current = Option.flatMap(Option.fromUndefinedOr(current.value.parentSpanId), (parent) =>
      Option.fromUndefinedOr(byId.get(parent)),
    );
  }

  return ids;
};

const named = (records: ReadonlyArray<TelemetryRecord>, name: string) =>
  Option.getOrThrow(Option.fromUndefinedOr(spans(records).find((record) => record.name === name)));

describe("telemetry", () => {
  let sandbox: Sandbox;

  beforeAll(() => {
    sandbox = openSandbox();
  });

  afterAll(async () => {
    await sandbox.github.stop();
  });

  test("a run in the foreground writes its spans to its own file in the home, its output as before", async () => {
    sandbox.github.addIssue("Do the thing", ["auto:eligible"]);

    const { code, output, pid } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);

    expect(output).toContain("done: #1:");
    expect(output).not.toContain('"type":"span"');
    expect(code).toBe(0);

    const records = recordsOf(sandbox.home, "cli", pid);

    // The command that starts the run names its repo and flow, and the event
    // it publishes names the run too, under the command's span.
    const starting = named(records, "command.StartSpokeRunCommand");
    const started = named(records, "event.RunStarted");
    const runId = String(started.attributes?.["run.id"]);

    expect(starting.attributes).toMatchObject({
      "run.repo": "demo",
      "run.flow": "implement",
    });
    expect(started.attributes).toMatchObject({
      "run.repo": "demo",
      "run.flow": "implement",
    });
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(lineage(records, started)).toContain(String(starting.spanId));

    // The commands, queries and events about the run after it name it on their spans.
    const aboutRun = (name: string) =>
      spans(records).filter(
        (record) => record.name === name && record.attributes?.["run.id"] === runId,
      );

    const unnamed = [
      "command.EnterStepCommand",
      "query.FindRunQuery",
      "event.RunEnteredStep",
      "event.RunFinished",
      "event.RunMarkersReleased",
    ].filter((name) => aboutRun(name).length === 0);

    expect(unnamed).toEqual([]);

    // A step's event is handled under the step's command.
    const entered = aboutRun("event.RunEnteredStep")[0];
    const entering = spans(records).filter((record) => record.name === "command.EnterStepCommand");

    expect(
      entering.some((command) => lineage(records, entered).includes(String(command.spanId))),
    ).toBe(true);
  }, 60_000);

  test("a command with nothing to trace writes no file, and prints as before", async () => {
    const { code, output, pid } = await sandbox.runCli(["--help"]);

    expect(code).toBe(0);
    expect(output).toContain("chernabog");
    expect(recordsOf(sandbox.home, "cli", pid)).toEqual([]);
  }, 30_000);
});

describe("today's telemetry, for a process with no bound of its own", () => {
  let sandbox: Sandbox;
  // None until a test starts it, so a test cut short stops nothing.
  let daemon: Option.Option<ChildProcess> = Option.none();
  const stopped = "writes no more telemetry until the next UTC day";

  beforeAll(() => {
    sandbox = openSandbox();
    // Today's folder already holds the day's cap, in a sparse file another
    // process left (#701).
    const today = join(sandbox.home, "telemetry", new Date().toISOString().slice(0, 10));
    mkdirSync(today, { recursive: true });
    const file = openSync(join(today, "cli-1.jsonl"), "w");
    ftruncateSync(file, TELEMETRY_RETENTION.maxBytes);
    closeSync(file);
  });

  afterAll(async () => {
    for (const running of Option.toArray(daemon)) {
      if (Option.isNone(Option.fromNullishOr(running.exitCode))) {
        running.kill("SIGTERM");
        await closed(running);
      }
    }

    await sandbox.github.stop();
  }, 30_000);

  test("a CLI call past the day's cap writes none, and says so once on stderr", async () => {
    const { code, output, pid } = await sandbox.runCli(["run", "implement", "--repo", "demo"]);

    expect(code).toBe(0);
    expect(output.split(stopped)).toHaveLength(2);
    expect(recordsOf(sandbox.home, "cli", pid)).toEqual([]);
  }, 60_000);

  test("the daemon past the day's cap says so once in daemon.log, and writes none", async () => {
    const started = sandbox.cli(["daemon"]);
    daemon = Option.some(started);

    await waitFor(() => sandbox.daemonLog().includes(stopped), "the daemon's telemetry notice");

    expect(sandbox.daemonLog().split(stopped)).toHaveLength(2);
    expect(recordsOf(sandbox.home, "daemon", started.pid ?? -1)).toEqual([]);
  }, 60_000);
});
