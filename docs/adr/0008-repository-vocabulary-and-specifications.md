# 8. Repositories speak the persistence vocabulary, and every read takes a specification

Status: accepted, 2026-10-31. Issue #281. Supersedes, in
[ADR 1](0001-ddd-use-cases-and-ports.md)'s list of what was left behind,
"specifications, unless a query needs a reusable predicate".

## Context

ADR 1 adopted dataquail/functional-domain-driven-hexagon's repositories but
left its specifications behind. `architecture.yaml` then held a repository
port to four method names, `findAll`, `findOne`, `save` and `remove`, and all
twelve ports passed. The arguments were free, so a variant finder passed under
an allowed name: `RunsRepository.findAll` took `{ running: true } | { latest:
n } | { repo }`, three finders in one; `RunMarkersRepository.findAll` took a
query object over run and status; the waits, steps and skips each took a key
or a count; and `FlowImportsRepository.findAll` returned a map rather than
aggregates. Each live adapter wrote its own `WHERE` for each variant, and each
fake re-implemented the same rule in memory, where the two could drift.

The hexagon's ADR-0005 settles this with two halves of one vocabulary and a
specification every read takes.

## Decisions

1. **The vocabulary.** A repository port declares only:
   - reads: `findOne` and `findMany`, each taking a `Specification` of its
     aggregate, and answering an `Option` and an array;
   - writes: `insertOne`/`insertMany`, `updateOne`/`updateMany`,
     `deleteOne`/`deleteMany` and `upsertOne`/`upsertMany`.

   `architecture.yaml` holds both halves as two members rules on
   `domain/<aggregate>/*.repository.ts`, each with its own probe: a `find*`
   name other than `findOne`/`findMany` is a keyed or variant finder, and any
   other name not in the write list is a domain verb.

2. **The specification kit** is `src/kernel/specification.ts`, ported from the
   hexagon. A `Specification<T>` is a predicate that also carries its
   `Criteria`, a closed AST of `And`, `Or`, `Not`, `IsNull`, `IsNotNull` and
   `Eq` over the aggregate's root-level scalar fields. The `Spec` builders are
   the only way to make one, so a predicate over a child collection can't be
   handed to a repository. `Spec.all()` is the empty conjunction.
3. **One specifications bag per aggregate read by a predicate**:
   `domain/<aggregate>/<aggregate>.specification.ts` exports
   `<Aggregate>Specifications` (`RunSpecifications.running`, `.withId(id)`,
   `.forRepo(repo)`), with a sibling `.specification.test.ts` the rule
   requires. A handler composes them at the call site with `Spec.and`,
   `Spec.or` and `Spec.not`.
4. **The adapters filter with the same object.**
   - The SQLite repositories (the runs module's six) compile `spec.criteria`
     to a WHERE fragment with `criteriaToWhere`
     (`modules/runs/infrastructure/repositories/criteria-to-sql.ts`), through
     a field-to-column map in each mapper. The repository owns everything
     else: the table, the projection and the order.
   - The file-backed repositories load the file and filter with the spec.
   - Every fake filters with the spec.
5. **A store kept where the aggregate says** (a scenario file at its `path`,
   a checkout's `.chernabog/config.yaml` at its `root`) can't list every
   aggregate and filter. Its live adapter reads that place from the spec with
   `pinnedValue`, the value an `Eq` pins the field to, and dies on a spec that
   pins none, as `criteriaToWhere` dies on an unmapped field: a bug in the
   caller, not a query.
6. **No limit in the DSL.** "The latest _n_ runs" and "the latest _n_ skips"
   are a limit and an order, which a predicate deliberately can't say. Their
   queries read `findMany(…Specifications.all)` and take _n_ themselves until
   the queries task (#283) moves those reads out of the repository and onto
   state.db directly, with a `LIMIT`.
7. **A repository port lives beside its aggregate**, as
   `domain/<aggregate>/<base>.repository.ts`, not under
   `domain/ports/repositories/`. `domain/ports/` keeps the client ports.
8. **`FlowImportRoot`** (`recipes/domain/flow-import/`) is the aggregate
   `FlowImportsRepository` stores and returns: a checkout's `root`, a `flow`
   and its `from`.

## Consequences

- No port has a keyed or variant finder. A new lookup is a new spec in the
  aggregate's bag, which the fake and the live adapter both honour without a
  new method or a new `WHERE`.
- A singleton aggregate (`MachineSetupRoot`) is read with
  `MachineSetupSpecifications.thisMachine`, the empty conjunction, and its
  handlers fall back to `MachineSetupRootOps.unset` for the `None` a spec can
  always answer.
- A flow-imports read that fails is a `PersistenceFailed`, as for the other
  file-backed stores; the recipes handlers map it to `RecipeFilesFailed`,
  since the aggregate's folder may not name the recipe aggregate's errors.
- Until #283, `ListRecentRunsQuery` and `ListRecentSkipsQuery` decode every
  run and skip to answer the latest few, where they read only those before.
  `om_skips` grows with every tick that starts nothing, so that query is the
  one to move first.
