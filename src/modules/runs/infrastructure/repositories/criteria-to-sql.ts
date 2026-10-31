// Compiles a specification's Criteria into a WHERE fragment for one of this
// module's SQLite tables. The repository owns everything else of the query:
//   SELECT <projection> FROM <table> WHERE ${where} ORDER BY …
// (docs/adr/0007-repository-vocabulary-and-specifications.md)

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Statement from "effect/sql/Statement";

import { Criteria } from "../../../../kernel/specification.ts";

// A spec's field names, mapped to the columns that store them. A value may be
// qualified ("om_runs.repo") so the fragment slots into a query that names
// more than one table. Each repository's map lives with its mapper.
export type ColumnMap = Readonly<Record<string, string>>;

export class UnmappedCriteriaField extends Schema.TaggedError<
  UnmappedCriteriaField,
  { readonly brand: "UnmappedCriteriaField" }
>()("UnmappedCriteriaField", { field: Schema.String }) {}

// A field with no column is a bug in the mapper, not a condition: it dies.
export const criteriaToWhere = (
  sql: Statement.Constructor,
  criteria: Criteria,
  columns: ColumnMap,
): Effect.Effect<Statement.Fragment> => {
  const column = (field: string) =>
    Option.match(Option.fromUndefinedOr(columns[field]), {
      onNone: () => Effect.die(new UnmappedCriteriaField({ field })),
      onSome: (mapped) => Effect.succeed(sql(mapped)),
    });

  const compile = (node: Criteria): Effect.Effect<Statement.Fragment> =>
    Criteria.$match(node, {
      And: ({ nodes }) => {
        if (nodes.length === 0) {
          return Effect.succeed(sql`TRUE`);
        }

        return Effect.map(Effect.forEach(nodes, compile), Statement.and);
      },
      // `Statement.or` folds an empty list to `1=1`, but an empty disjunction
      // is FALSE: delegating would invert the predicate.
      Or: ({ nodes }) => {
        if (nodes.length === 0) {
          return Effect.succeed(sql`FALSE`);
        }

        return Effect.map(Effect.forEach(nodes, compile), Statement.or);
      },
      Not: ({ node: inner }) => Effect.map(compile(inner), (fragment) => sql`(NOT ${fragment})`),
      IsNull: ({ field }) => Effect.map(column(field), (name) => sql`${name} IS NULL`),
      IsNotNull: ({ field }) => Effect.map(column(field), (name) => sql`${name} IS NOT NULL`),
      Eq: ({ field, value }) => Effect.map(column(field), (name) => sql`${name} = ${value}`),
    });

  return compile(criteria);
};
