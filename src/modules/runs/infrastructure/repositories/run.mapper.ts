// A run as om_runs stores it: snake_case columns, absent values as NULL.

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { RunRoot, RunStatus } from "../../domain/run/run.root.ts";
import { WorkItem } from "../../domain/run/work-item.value-object.ts";

const Maybe = Schema.OptionFromNullOr(Schema.String);

// The work item, as JSON text.
const ItemColumn = Schema.OptionFromNullOr(Schema.fromJsonString(WorkItem));

const encodeItem = Schema.encodeSync(ItemColumn);

export const RunColumns = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  persona: Maybe,
  flow: Schema.String,
  item_key: Schema.String,
  item_title: Maybe,
  item_url: Maybe,
  item: ItemColumn,
  execution_id: Maybe,
  // A JSON array, which the query builds from om_run_subjects.
  subjects: Schema.fromJsonString(Schema.Array(Schema.String)),
  status: RunStatus,
  current_step: Maybe,
  summary: Maybe,
  core_version: Schema.String,
  config_tree: Maybe,
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
    item: row.item,
    executionId: row.execution_id,
    subjects: row.subjects,
    status: row.status,
    currentStep: row.current_step,
    summary: row.summary,
    coreVersion: row.core_version,
    configTree: row.config_tree,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });

// The run's values as SQL parameters, in om_runs' columns' order, with its
// subjects, which om_run_subjects keeps, after its execution.
export const toParameters = (run: RunRoot) =>
  [
    run.id,
    run.repo,
    Option.getOrNull(run.persona),
    run.flow,
    run.itemKey,
    Option.getOrNull(run.itemTitle),
    Option.getOrNull(run.itemUrl),
    encodeItem(run.item),
    Option.getOrNull(run.executionId),
    run.subjects,
    run.status,
    Option.getOrNull(run.currentStep),
    Option.getOrNull(run.summary),
    run.coreVersion,
    Option.getOrNull(run.configTree),
    run.startedAt,
    Option.getOrNull(run.finishedAt),
  ] as const;
