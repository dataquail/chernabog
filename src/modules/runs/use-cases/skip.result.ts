import * as Schema from "effect/Schema";

const Maybe = Schema.OptionFromNullOr(Schema.String);

// Why a tick started nothing, as `status` shows it.
export class SkipView extends Schema.Class<SkipView, { readonly brand: "SkipView" }>("SkipView")({
  repo: Schema.String,
  persona: Maybe,
  flow: Schema.String,
  itemKey: Maybe,
  reason: Schema.String,
  at: Schema.String,
}) {}

export class SkipList extends Schema.Class<SkipList, { readonly brand: "SkipList" }>("SkipList")({
  skips: Schema.Array(SkipView),
}) {}
