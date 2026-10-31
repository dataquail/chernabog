# 9. Queries read their storage directly and never reach the domain

Status: accepted, 2026-10-31. Issue #283. Supersedes the consequence of
[ADR 6](0006-use-cases-become-commands-and-queries.md) that "a query may call
its aggregate's predicates in `*.root-ops.ts`".

## Context

ADR 6 moved every use-case to a command or a query, and let a query read the
way a use-case had: through its aggregate's repository, asking the root's ops
what a record means. So the 34 query handlers read the write model. A change
to an aggregate's shape ripples into what `status`, the TUI and the daemon
show; a read can't be shaped for whoever asks without reshaping the
aggregate; and the views the queries answer with (`run-view`, `run-wait-view`,
`run-marker-view`, `hold-view`, `skip-view`, `run-history`,
`enrolled-repo-summary`) sit in the domain as value objects, though no command
needs most of them.

dataquail/functional-domain-driven-hexagon draws the line the other way. Its
`queries-isolation` rule (`packages/server/architecture.yaml`) lets a query
build its own read model, reading SQL directly; from its module's domain it
may take only branded ids and cross-context ACL ports. Roots, ops,
repositories, specifications, value objects, errors and events are the write
side's, and read-side errors and statuses live in the `*.query.ts`.

## Decisions

1. **What a query may name.** effect (its `FileSystem` among it), the CQRS
   library, the kernel, its sibling queries, its module's branded ids
   (`domain/*/*.id.ts`), its module's ACL ports (`domain/ports/acl/**`), its
   module's `storage/` (decision 4), and `@/platform/home.ts` for where
   chernabog keeps its files. Then, by where the data is:
   - **Files:** a query over a file reads it with the filesystem directly, and
     machine config with `yaml`. The `yaml` deny admits
     `@/modules/*/queries/**`.
   - **SQLite:** a runs query reads `state.db` with SQL. The `@effect/sql*`
     deny admits `@/modules/runs/queries/**`.
   - **Third-party systems** (GitHub, git, launchd, the workflow engine, an
     agent CLI): a query keeps its `domain/ports/clients/` port. The hexagon
     has no such case, since its queries only read SQL; but a client port is
     not the write model. It reads a system no command here owns, and the
     integration tests already run the live client (git in a scratch repo) or,
     for a remote system, its fake. Duplicating gh or launchd behind a second,
     query-side adapter would buy nothing.

   Roots, ops, repositories, specifications, value objects, errors and events
   are off-limits.

2. **Read models live with the query.** Each view moves into the `*.query.ts`
   that answers with it, beside its read-side errors. A view several queries
   share lives in the first one's `*.query.ts`, and its siblings import it
   from there (siblings may name each other).
3. **A command never answers with a query's view.** A command can't name a
   query (ADR 6, decision 4), so where one answered with a view, it returns
   less, and the adapter that shows the result asks the query:
   - `FinishRunCommand` answers with the run's id and how it ended; the CLI
     that reports a finished run dispatches `FindRunQuery` for the view.
   - `CancelledRun` is the cancel command's own result, declared in its
     `*.command.ts`: what cancelling cleaned up, and the cancelled run's id.
     The CLI and the TUI ask `FindRunQuery` for the run they print.

   A command-side shape stays in the domain only where a command, not an
   adapter, needs it.

4. **Storage formats stay the adapters' business.** A query decodes what it
   reads with its own Schema. Where it reads what a repository writes
   (`trust.json`, `paused.json`, machine config's YAML, a `state.db` table),
   the two share the format and nothing else: a `<name>.schema.ts` in the
   module's `storage/`, the hexagon's `RowSchemas`. `storage/` names effect,
   and only the module's repositories and queries may name it. Turning a row
   into an aggregate stays the repository's mapper; turning it into a read
   model, the query's handler. `trust/storage/trust-file.schema.ts` is the
   first.
5. **Reads that decide.** Sixteen queries called root-ops to decide
   something. Each either states the rule over its read model, or is a
   write-side decision and is reclassified:

   | Query                     | Decision                                                                                              |
   | ------------------------- | ----------------------------------------------------------------------------------------------------- |
   | `check-trust`             | Over the read model: trusted while the tree on the base branch is the one `trust.json` records. Done. |
   | `check-run-validity`      | Over the read model: whether the run's row is running.                                                |
   | `find-active-run`         | Over the read model: the running row for the item, in SQL.                                            |
   | `list-unreleased-markers` | Over the read model: markers whose run's row is no longer running, in SQL.                            |
   | `list-unsupported-runs`   | Over the read model: rows this binary can't resume, in SQL.                                           |
   | `resolve-run-id`          | Over the read model: the run ids that start with the prefix asked.                                    |
   | `list-moved-repos`        | Over the read model: machine config entries whose path is no longer a checkout.                       |
   | `inspect-account-dir`     | Over the read model: which agent's login a directory holds, by its files.                             |
   | `diff-recipes`            | Over the read model: the repo's recipe manifest beside the package's files.                           |
   | `list-recipes`            | Over the read model: the packages' recipes beside the copies and imports in `.chernabog/`.            |
   | `load-scenario`           | Over the read model: the scenario file, decoded with its own Schema.                                  |
   | `choose-seeded-work`      | Over the read model: the seeded items a scenario lists.                                               |
   | `check-rehearsal`         | Over the read model: the scenario's expectations beside what the rehearsal did.                       |
   | `plan-enrollment`         | Write side: the wizard's plan, reclassified as a command.                                             |
   | `plan-setup`              | Write side: the wizard's plan, reclassified as a command.                                             |
   | `plan-rehearsal`          | Write side: the wizard's plan, reclassified as a command.                                             |

   A wizard's plan applies the aggregate's rules (which flows to offer,
   which choices a persona inherits, which logins are stand-ins) to decide
   what the matching apply command will do. Restating those rules over a
   read model would keep two copies that must agree, so the plan moves to the
   write side as a command that changes nothing and answers with the plan,
   and names the domain as commands do. Its test becomes a
   `*.handler.test.ts` over the fakes.

6. **The `read-models` campaign counts what's left.** `campaigns.read-models`
   in `architecture.yaml` counts each file under `queries/` (tests aside) that
   imports a root, root-ops, repository, specification, value object, error or
   event, in a ledger under `.architecture-campaigns/` that may only shrink,
   so a new query that reaches the domain fails `bun run lint:architecture`.
   A change that moves one runs `bun run architecture:clear` and commits the
   ledger with it. The queries' allowlist keeps `@/modules/{module}/domain/**`
   until the ledger is empty; then it narrows to ids, ACL and client ports,
   `port-consumers` and root-ops' `importedBy` drop `queries/`, and the
   campaign retires.

## Consequences

- `src/modules/trust/` is the worked example: `check-trust` and
  `find-trusted-tree` read `trust.json` with `FileSystem` and decode it with
  `TrustFile` from `storage/`, which the repository writes with; their
  integration tests, seeded through the live repository, pass unchanged.
- A query's integration test may still seed through the live repository: it
  proves the query reads what the write side writes.
- `handlers-reach-no-adapter` lets a query reach `@/platform/home.ts`, which
  names no adapter.
- Each allowance a query needs (`yaml`, `@effect/sql-sqlite-bun`, an ACL
  port) is added by the move that first uses it, since the conformance check
  holds an unused allowance at zero.
- ADR 6's decision 4 is unchanged: a query never dispatches, so one that
  needs another's answer reads the same storage itself.
