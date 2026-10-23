import { printJson } from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  lastJsonObject,
  withAnswerFormat,
} from "../src/modules/runs/infrastructure/runtime/agents/adapter.ts";
import { checkAnswer } from "../src/modules/runs/infrastructure/runtime/agents/stop-hook.ts";
import { latestRateLimits } from "../src/modules/runs/infrastructure/runtime/codex-usage.ts";

describe("agent output", () => {
  test("the last JSON object in a message is the answer", () => {
    expect(lastJsonObject('Here you go:\n{"a": {"b": 1}}\nthanks')).toEqual(
      Option.some({ a: { b: 1 } }),
    );
    expect(lastJsonObject('{"first": 1} then {"second": 2}')).toEqual(Option.some({ second: 2 }));
    expect(lastJsonObject("no json")).toEqual(Option.none());
  });

  test("the schema goes into the prompt only when there is one", () => {
    expect(withAnswerFormat("do it", Option.none())).toBe("do it");
    expect(withAnswerFormat("do it", Option.some({ type: "object" }))).toContain(
      "## Answer format",
    );
  });

  test("an interactive session's answer file is checked against the schema", () => {
    const schema = Option.some({
      type: "object",
      properties: { verdict: { type: "string", enum: ["approve", "request-changes"] } },
      required: ["verdict"],
    });

    expect(checkAnswer(schema, Option.some('{"verdict":"approve"}'))).toEqual(
      Result.succeed({ verdict: "approve" }),
    );
    expect(Result.getFailure(checkAnswer(schema, Option.none()))).toEqual(
      Option.some("There is no answer file yet."),
    );
    expect(Result.getFailure(checkAnswer(schema, Option.some('{"verdict":')))).toEqual(
      Option.some("The answer file is not valid JSON."),
    );
    expect(Result.getFailure(checkAnswer(schema, Option.some('{"verdict":"maybe"}')))).toEqual(
      Option.some(expect.stringContaining('"approve" | "request-changes"')),
    );
  });

  test("Codex's rate limits come from its newest token_count event", () => {
    const line = (used: number) =>
      printJson({
        timestamp: "2026-10-17T10:00:00Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: used, resets_at: 1792260000 },
            secondary: { used_percent: 30, resets_at: 1792500000 },
          },
        },
      });

    const reading = latestRateLimits(
      [line(10), '{"type":"other"}', line(25)].join("\n"),
      DateTime.makeUnsafe("2026-10-17T11:00:00Z"),
    );

    expect(Option.map(reading, (found) => found.fiveHour.used)).toEqual(Option.some(0.25));
    expect(Option.map(reading, (found) => found.sevenDay.used)).toEqual(Option.some(0.3));
    expect(Option.map(reading, (found) => DateTime.toEpochMillis(found.fiveHour.resetsAt))).toEqual(
      Option.some(1792260000 * 1000),
    );
  });
});
