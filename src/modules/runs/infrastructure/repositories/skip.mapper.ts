// A skip as om_skips stores it.

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { SkipRoot } from "../../domain/skip/skip.root.ts";

const Maybe = Schema.OptionFromNullOr(Schema.String);

export const SkipColumns = Schema.Struct({
  repo: Schema.String,
  persona: Maybe,
  flow: Schema.String,
  item_key: Maybe,
  reason: Schema.String,
  at: Schema.String,
});

export const toRoot = (row: typeof SkipColumns.Type) =>
  SkipRoot.make({
    repo: row.repo,
    persona: row.persona,
    flow: row.flow,
    itemKey: row.item_key,
    reason: row.reason,
    at: row.at,
  });

export const nullable = (value: Option.Option<string>) => Option.getOrNull(value);
