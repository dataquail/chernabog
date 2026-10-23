// A run as om_runs stores it: snake_case columns, absent values as NULL.

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunRoot, RunStatus } from "../../domain/run/run.root.ts";

const Maybe = Schema.OptionFromNullOr(Schema.String);

export const RunColumns = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  persona: Maybe,
  flow: Schema.String,
  item_key: Schema.String,
  item_title: Maybe,
  item_url: Maybe,
  execution_id: Maybe,
  status: RunStatus,
  current_step: Maybe,
  summary: Maybe,
  started_at: Schema.String,
  finished_at: Maybe,
});

export type RunColumns = typeof RunColumns.Type;

export const toRoot = (row: RunColumns) =>
  RunRoot.make({
    id: RunId.make(row.id),
    repo: row.repo,
    persona: row.persona,
    flow: row.flow,
    itemKey: row.item_key,
    itemTitle: row.item_title,
    itemUrl: row.item_url,
    executionId: row.execution_id,
    status: row.status,
    currentStep: row.current_step,
    summary: row.summary,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });

// The run's values, in the columns' order, as SQL parameters.
export const toParameters = (run: RunRoot) =>
  [
    run.id,
    run.repo,
    Option.getOrNull(run.persona),
    run.flow,
    run.itemKey,
    Option.getOrNull(run.itemTitle),
    Option.getOrNull(run.itemUrl),
    Option.getOrNull(run.executionId),
    run.status,
    Option.getOrNull(run.currentStep),
    Option.getOrNull(run.summary),
    run.startedAt,
    Option.getOrNull(run.finishedAt),
  ] as const;
