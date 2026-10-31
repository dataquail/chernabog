import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";

// Criteria: a small, closed AST of predicates over an aggregate's ROOT-LEVEL
// scalar fields. It deliberately has no "some child matches …" node: a spec
// can say `finished_at IS NULL`, never `subjects contains pr-12`. That keeps
// translating it to a WHERE fragment sound (there is one root row to filter)
// and makes a join-shaped filter unconstructable: a predicate that reaches
// into a child collection can only be a plain `Predicate`, never a
// `Specification`, so it can never be handed to a repository.
// (docs/adr/0008-repository-vocabulary-and-specifications.md)
export type Criteria = Data.TaggedEnum<{
  And: { readonly nodes: ReadonlyArray<Criteria> };
  Or: { readonly nodes: ReadonlyArray<Criteria> };
  Not: { readonly node: Criteria };
  IsNull: { readonly field: string };
  IsNotNull: { readonly field: string };
  Eq: { readonly field: string; readonly value: string | number | boolean };
}>;

export const Criteria = Data.taggedEnum<Criteria>();

// An eval-only predicate over a whole aggregate: a domain guard, or a filter
// after a load. It carries no Criteria, so no repository can take it.
export type Predicate<T> = (candidate: T) => boolean;

// A Predicate that ALSO carries its Criteria, so the same object filters in
// memory (a fake, a file-backed repository, a guard) and compiles to SQL (a
// SQLite repository). The builders below are the only way to make one, which
// is what bounds the DSL to root-level scalars.
export type Specification<T> = Predicate<T> & {
  readonly criteria: Criteria;
};

const make = <T>(predicate: Predicate<T>, criteria: Criteria): Specification<T> =>
  Object.assign((candidate: T) => predicate(candidate), { criteria });

// An `Option` field is absent when it's `None`, which SQL reads as NULL.
const isAbsent = <V>(value: V): boolean =>
  (Option.isOption(value) && Option.isNone(value)) || P.isNullish(value);

const isNull = <T>(field: keyof T & string): Specification<T> =>
  make<T>((candidate) => isAbsent(candidate[field]), Criteria.IsNull({ field }));

const isNotNull = <T>(field: keyof T & string): Specification<T> =>
  make<T>((candidate) => !isAbsent(candidate[field]), Criteria.IsNotNull({ field }));

const eq = <T, K extends keyof T & string>(
  field: K,
  value: Extract<T[K], string | number | boolean>,
): Specification<T> =>
  make<T>((candidate) => candidate[field] === value, Criteria.Eq({ field, value }));

// Every spec holds of a candidate. With none, `and` is true of everything.
const and = <T>(...specs: ReadonlyArray<Specification<T>>): Specification<T> =>
  make<T>(
    (candidate) => specs.every((spec) => spec(candidate)),
    Criteria.And({ nodes: specs.map((spec) => spec.criteria) }),
  );

// Some spec holds of a candidate. With none, `or` is true of nothing.
const or = <T>(...specs: ReadonlyArray<Specification<T>>): Specification<T> =>
  make<T>(
    (candidate) => specs.some((spec) => spec(candidate)),
    Criteria.Or({ nodes: specs.map((spec) => spec.criteria) }),
  );

const not = <T>(spec: Specification<T>): Specification<T> =>
  make<T>((candidate) => !spec(candidate), Criteria.Not({ node: spec.criteria }));

// Every aggregate there is: the empty conjunction.
const all = <T>(): Specification<T> => and<T>();

export const Spec = { isNull, isNotNull, eq, and, or, not, all } as const;

// The value a spec pins `field` to, if it does: an Eq on the field, alone or
// in a conjunction. A store kept at a place the aggregate names, such as a
// scenario file at its path, reads it from the spec to know what to load
// before filtering with the spec itself.
export const pinnedValue = (
  criteria: Criteria,
  field: string,
): Option.Option<string | number | boolean> =>
  Criteria.$match(criteria, {
    Eq: (node) => Option.filter(Option.some(node.value), () => node.field === field),
    And: ({ nodes }) => Option.firstSomeOf(nodes.map((node) => pinnedValue(node, field))),
    Or: () => Option.none(),
    Not: () => Option.none(),
    IsNull: () => Option.none(),
    IsNotNull: () => Option.none(),
  });
