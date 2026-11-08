// What an agent call spent, as om_agent_usage stores it.

import * as Option from "effect/Option";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { TokenUsageRoot } from "../../domain/token-usage/token-usage.root.ts";
import { TokenUsageRow } from "../../storage/token-usage.schema.ts";
import { type ColumnMap } from "./criteria-to-sql.ts";

export const TokenUsageColumns = TokenUsageRow;

export const toRoot = (row: TokenUsageRow) =>
  TokenUsageRoot.make({
    runId: RunId.make(row.run_id),
    step: Option.fromNullishOr(row.step),
    adapter: row.adapter,
    sessionId: row.session_id,
    model: Option.fromNullishOr(row.model),
    input: Option.fromNullishOr(row.input),
    output: Option.fromNullishOr(row.output),
    cacheRead: Option.fromNullishOr(row.cache_read),
    cacheWrite: Option.fromNullishOr(row.cache_write),
    reported: row.reported !== 0,
    recordedAt: row.recorded_at,
  });

export const toRow = (usage: TokenUsageRoot): TokenUsageRow => ({
  run_id: usage.runId,
  step: Option.getOrNull(usage.step),
  adapter: usage.adapter,
  session_id: usage.sessionId,
  model: Option.getOrNull(usage.model),
  input: Option.getOrNull(usage.input),
  output: Option.getOrNull(usage.output),
  cache_read: Option.getOrNull(usage.cacheRead),
  cache_write: Option.getOrNull(usage.cacheWrite),
  reported: Number(usage.reported),
  recorded_at: usage.recordedAt,
});

// Each field of a usage row, as the om_agent_usage column a spec's WHERE names.
export const tokenUsageColumns: ColumnMap = {
  runId: "run_id",
  step: "step",
  adapter: "adapter",
  sessionId: "session_id",
  model: "model",
  input: "input",
  output: "output",
  cacheRead: "cache_read",
  cacheWrite: "cache_write",
  reported: "reported",
  recordedAt: "recorded_at",
};
