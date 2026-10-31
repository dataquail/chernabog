// Holds as om_holds stores them: a row per held item.

import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";

import { samePersona } from "../../../../kernel/persona.value-object.ts";
import { HoldsRoot } from "../../domain/holds/holds.root.ts";
import { type ColumnMap } from "./criteria-to-sql.ts";

export const HoldColumns = Schema.Struct({
  repo: Schema.String,
  persona: Schema.OptionFromNullOr(Schema.String),
  flow: Schema.String,
  item_key: Schema.String,
  reason: Schema.String,
  at: Schema.String,
});

type HoldRow = typeof HoldColumns.Type;

const sameFlow = (one: HoldRow, other: HoldRow) =>
  one.repo === other.repo && one.flow === other.flow && samePersona(one.persona, other.persona);

const toRoot = (flowRows: Arr.NonEmptyReadonlyArray<HoldRow>) => {
  const first = Arr.headNonEmpty(flowRows);

  return HoldsRoot.make({
    repo: first.repo,
    persona: first.persona,
    flow: first.flow,
    items: flowRows.map((row) => ({ itemKey: row.item_key, reason: row.reason })),
    at: first.at,
  });
};

// Rows in order, one root per flow they're of.
export const toRoots = (rows: ReadonlyArray<HoldRow>): ReadonlyArray<HoldsRoot> => {
  if (!Arr.isReadonlyArrayNonEmpty(rows)) {
    return [];
  }

  return Arr.groupWith(rows, sameFlow).map(toRoot);
};

// Each scalar field of a flow's holds, as the om_holds column a spec's WHERE
// names: every row of the flow carries it.
export const holdsColumns: ColumnMap = { repo: "repo", persona: "persona", flow: "flow", at: "at" };
