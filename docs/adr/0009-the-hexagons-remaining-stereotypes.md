# 9. The hexagon's remaining stereotypes

Status: accepted, 2026-10-31. Issue #291, part of the architecture cleanup.
Extends [ADR 1](0001-ddd-use-cases-and-ports.md) and
[ADR 6](0006-use-cases-become-commands-and-queries.md).

## Context

ADR 1 adopted dataquail/functional-domain-driven-hexagon's layout, and ADR 6
its commands and queries. The hexagon names more stereotypes than either
brought over: its `.claude/rules/server-module-layout.md`, its ADR-0003
(aggregates), ADR-0023 (domain services and interface utils) and ADR-0024
(dot-delimited stereotype filenames, and identifiers that carry the
stereotype). Without them, chernabog's domain had nowhere to put a part of an
aggregate that isn't a root, or logic that no aggregate owns. So `runs/domain/`
grew aggregate folders with no root (`routing/`, `schedule/`, `usage/`), a
root with no ops for what is really a part of a run (`run-step/`), and value
objects for what is really a part of an enrolled repo (`persona-choices`).

Specifications, ACL ports, the module gateways, event handlers, interface utils
and query integration tests each have their own task in the epic, and are not
decided here.

`architecture.yaml` holds vacant nodes at zero: a node that states an import
allowlist and selects no file fails the conformance report. So a stereotype
lands with its first real file, or not at all; this ADR says which are here,
and why each of the others isn't yet.

## Decisions

### Adopted, each with its first file

1. **Entities, `*.entity.ts`, exporting `XEntity`.** A part of an aggregate with
   an identity of its own but no lifecycle apart from its root. The first is
   `RunStepEntity` (`runs/domain/run/run-step.entity.ts`), a step a run
   entered: it was `run-step/run-step.root.ts`, a root with no ops, and moves
   into the run it belongs to, with the `RunHistory` value object that reads
   steps back. `om_steps` and its repository are unchanged.
2. **Constituent aggregates, `*.aggregate.ts`.** A part of a root that gathers
   value objects, but is not a consistency boundary. The first is
   `persona-choices.aggregate.ts`: a persona's account, roles, flows and
   schedule for a repo, which only the enrolled repo keeps consistent.
3. **The constituent ops bag, `*.aggregate-ops.ts`, exporting `XAggregateOps`.**
   Invariants on a constituent aggregate, which the root's ops compose. It owes
   a sibling test, and only its module's `domain/` (and tests) may import it:
   the hexagon's `constituent-ops` def, ported. The first is
   `PersonaChoicesAggregateOps.pickAccount`, moved out of
   `EnrolledRepoRootOps.setAccount`, which now delegates to it.
4. **Domain services, `domain/domain-services/*.domain-service.ts`.** A pure
   free-function bag, with a required test, for domain logic no single
   aggregate owns. The first is `Routing` (`split`, `describeElsewhere`), which
   was `runs/domain/routing/routing.value-object.ts`: it splits a trigger's
   work items between this persona and others before any run exists, so no
   aggregate is its home. The hexagon's guard against anemia applies: logic
   that reads or changes one aggregate stays on that aggregate's ops.
5. **Identifiers carry their stereotype**, held by a surface rule on each kind
   of file: a `*.root.ts` exports only `XRoot`, a `*.root-ops.ts` only
   `XRootOps`, a `*.aggregate-ops.ts` only `XAggregateOps`, a `*.entity.ts`
   only `XEntity`, and a module's `*.id.ts` only `XId` (types are free in all
   of them). `RunStatus`, `RunEnding` and `MarkerStatus` were schemas exported
   from root files; each moves to a value object of its own
   (`run-status.value-object.ts`, `marker-status.value-object.ts`).
6. **`<module>.event-span-attributes.ts`**, at the module root, named for its
   module. `runs.event-span-attributes.ts` extracts `run.id`, `run.repo` and
   `run.flow` from the runs' commands, queries and events wherever they carry
   them, and the runs' dispatchers (`Command.dispatcher` / `Query.dispatcher`)
   and event bus (`makeEventBus`) are built with it, so a span can be found by
   the run it was for. It names its module's domain, the kernel and the CQRS
   library, and its test sits beside it.
7. **`camel-case-value-exports` on handler files**, beside
   `one-handler-export`: a handler's value exports are camelCase.
8. **`*.mapper.test.ts`** is an admitted test kind in
   `infrastructure/repositories/`, held to its mapper, its module's domain and
   the kernel: a row is a value, so its test runs no store. The first is
   `run-step.mapper.test.ts`. The folder's other tests are named for what they
   are, `*.repository-live.test.ts`, rather than admitted as any `*.test.ts`.

### Not yet: each lands with its first file

9. **The value-object rename, `XValueObject`, the value-object ops bag
   (`*.value-object-ops.ts`) and an aggregate's `value-objects/` subfolder.**
   They come together, in a follow-up. Today a value object is named
   `RunView` or `CancelledRun`, and many value-object files carry free
   functions beside their schemas (`schedule`, `tick`, `validity`, `lease`,
   `work-item`, `repo-manifest`, …). Holding a `*.value-object.ts` to
   `XValueObject` means renaming about fifty identifiers that the CLI, the
   TUI, the daemon's protocol and its client all name, and moving those
   functions into ops bags (or domain services) that only some of their
   callers may import. A `value-objects/` subfolder moves the same files and
   touches the same importers, so it belongs in that change rather than
   churning every importer twice.
10. **The entity ops bag, `*.entity-ops.ts`.** `RunStepEntity` has no logic of
    its own yet; the node lands with the first entity that does.
11. **`*.repository-fake.test.ts`.** No fake carries logic worth a test of its
    own: each is tested through the handlers that run over it. The node lands
    with the first fake that does.
12. **Sagas, `sagas/*.saga.ts`.** A saga is a process manager that correlates
    several post-commit events over time and compensates when a later step
    fails; bus-only, with no repositories and no ops. None of chernabog's
    reactions does that yet: each of the events the runs, enrollment and trust
    modules dispatch decides its own outcome. `sagas/` lands with the first
    reaction that has to wait on a second event, never as an empty node.

### Left where they are, for a follow-up to decide

13. **The remaining aggregate folders with no root.** `runs/domain/schedule/`
    (schedule, tick, lease, validity, event-tick and notifications),
    `runs/domain/usage/` (`decideLaunch`) and `recipes/domain/scaffold/` are
    each either a domain service or value objects that belong under an
    aggregate. `usage/` is a domain service by the same reading as `Routing`;
    `schedule/` is most likely a missing root, a persona's flow as the daemon
    schedules it. Each is its own change, and the value-object rename above
    will touch most of their files anyway.
14. **`work-item.value-object.ts`'s `claimOf` and `itemTarget`** stay on the
    run aggregate. They read a work item's key by the SDK's conventions, which
    is the run's own concern: `RunRootOps` and `RunEvents` use `itemTarget`,
    and in the hexagon an aggregate may not import a domain service (see 16). The cleanup client and
    `cancel-run` call them as they call any of the run's value objects.
15. **`holds.root.ts` and `skip.root.ts`** stay roots with no ops: each is a
    record a query reads back, with no rule to keep. Run waits stay a root of
    their own (`RunWaitRootOps` races and releases them apart from the run).
16. **Aggregate isolation.** The hexagon makes a domain service the one domain
    folder that may compose several aggregates. Here an aggregate folder's
    `imports.allow` adds to `domain/`'s, which already admits the whole
    module's domain, so nothing yet stops one aggregate naming another
    (`schedule/` names `run/`'s `WorkItem` and `itemTarget`, and
    `run-history.value-object.ts` names `run-wait/`'s `RunWait`). Narrowing it
    with `reset: true` is its own change, once those crossings have moved.

### Not ported

17. **`policies/`, `*.policy-query.ts` and authorization.** Chernabog acts on one
    person's machine, as that person's own GitHub personas. There are no
    callers to authorize: whoever can reach the CLI, the TUI or the daemon's
    socket is the person. (`TrustRepoCommand` is a security gate, but it is
    gated by which adapter may dispatch it, not by a policy over a caller.)
18. **Per-module database schemas** (the hexagon's ADR-0020). Chernabog's state
    is one SQLite `state.db` that only the runs module and the workflow engine
    open, beside the YAML and JSON files each other module's repositories own.
    There is no shared database for a module to fence off.

## Consequences

- A part of an aggregate has a name for what it is. The next one (a run's
  waits, should they lose their own lifecycle, or a repo's checkout) has a
  stereotype to land in without a new decision.
- Each identifier rule is a surface rule with a probe, so a file that drifts
  from its stereotype fails `bun run lint` and `bun run lint:architecture`.
- The value-object rename is the largest piece still to come; until it lands,
  a value object's name doesn't say what it is.
