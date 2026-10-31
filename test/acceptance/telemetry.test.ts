// Every CLI command writes its spans and logs under the chernabog home's
// telemetry/, in a file of its own process: telemetry/<day>/cli-<pid>.jsonl.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { openSandbox, type Sandbox } from "./sandbox.ts";

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
    const started = named(records, "command.StartRunCommand");
    const runId = String(started.attributes?.["run.id"]);

    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(started.attributes).toMatchObject({
      "run.repo": "dataquail/demo",
      "run.flow": "implement",
    });

    // The commands after it, about the same run, say so on their spans too.
    expect(
      spans(records).some(
        (record) =>
          record.name === "command.FinishRunCommand" && record.attributes?.["run.id"] === runId,
      ),
    ).toBe(true);

    // The event the command published is handled under the command's span.
    const event = named(records, "event.RunStarted");

    expect(event.attributes?.["run.id"]).toBe(runId);
    expect(lineage(records, event)).toContain(String(started.spanId));
  }, 60_000);

  test("a command with nothing to trace writes no file, and prints as before", async () => {
    const { code, output, pid } = await sandbox.runCli(["--help"]);

    expect(code).toBe(0);
    expect(output).toContain("chernabog");
    expect(recordsOf(sandbox.home, "cli", pid)).toEqual([]);
  }, 30_000);
});
