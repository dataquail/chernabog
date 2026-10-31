# 9. Modules import and export, and ask each other through ACL ports

Status: accepted, 2026-10-31. Issue #285. Supersedes the `*.exports.ts` and
`*.imports.ts` module gateways on [ADR 1](0001-ddd-use-cases-and-ports.md)'s
list of what was left behind, and decision 6 of
[ADR 7](0007-module-gateways.md). Settles the decision
[ADR 2](0002-the-sweep-into-modules.md)'s "What's left" deferred, for the
gateway. Amends decision 1 of
[ADR 3](0003-use-cases-dont-compose-and-recovery-over-clean-stops.md) and
decision 4 of [ADR 6](0006-use-cases-become-commands-and-queries.md).

## Context

No module imports another. They couple through the legacy
`src/repo-config.ts` instead, which reads and edits machine config and a
repo's team config for whoever asks: the enrollment, machine, rehearsals,
recipes and runs modules all import it, and it imports enrollment's internals
back. That is a shared database between modules, with no owner, and the
`modules/{module}/` node's `importedBy` names it as the exception.

dataquail/functional-domain-driven-hexagon settled how one module asks
another (its ADR-0022 and ADR-0032): through a port the asking module owns,
whose adapter is the one place the other module's vocabulary appears, and
through two files each module states, what it grants its peers and what it
takes from them.

## Decisions

1. **Each part of what `repo-config.ts` reads has one owner**, which
   publishes queries for what others read of it:
   - **enrollment** owns the enrolled repos and their per-persona choices
     (machine config's `repos:`), as `EnrolledReposRepository` already
     stores them.
   - **machine** owns the machine's personas and accounts (machine config's
     `github:` and `accounts:`), as `MachineSetupsRepository` already does.
   - **recipes** owns the team's `.chernabog/config.yaml`: the repo's
     agent, runners and reviewers, its shared settings, and each flow's
     settings. The recipes module already owns the rest of `.chernabog/`: it
     scaffolds the tree, installs its recipe packages, writes
     `flows.<name>.from` into this very file (`FlowImportsRepository`) and
     generates its `config.schema.json`. A second module writing the file
     would be the shared database again. The team's config is read through
     `TeamConfigsRepository` and published as `ReadTeamConfigQuery`.

   What a module keeps for itself in machine config, such as the runs
   module's agents, launchers and usage gate, stays its own repository's: a
   module's own config is not another module's question.

2. **`<module>.exports.ts` is the peer surface.** It declares grants named
   `<module>Access<Queries|Commands|DomainEvents|Errors>`, each carved from
   the module's own message group with `Query.subsetOf` or
   `Command.subsetOf`, so a dispatcher a peer builds over it demands only
   those tags' registrations, and adding a message to the group cannot widen
   a grant. It re-exports nothing. A grant goes in only with its consumer.
3. **`<module>.imports.ts` is the inbound gateway.** It names other modules'
   `*.exports.ts` and nothing else, and only the module's ACL adapters read
   it. It is the one file a reviewer watches to see what a module takes.
4. **A module asks another only through an ACL port it owns.** The port is a
   `Context.Service` in `domain/ports/acl/<question>.acl.ts`, in the asking
   module's own words: its value objects, its errors. Its live adapter in
   `infrastructure/acl/<question>.acl-live.ts` takes the grant from its
   module's `imports.ts`, builds a dispatcher over it with the CQRS library,
   dispatches the owner's query and translates the answer and its failure
   into the port's types. It names nothing else: no repository, no client,
   no handler. Each port owes its `-live.ts`, `-fake.ts` and
   `-live.test.ts`, as the other ports do; the live test runs the adapter
   over the owner's own handlers and storage, staged by the shared harness.
   Enrollment's `TeamFlowsAcl`, which asks recipes' `ReadTeamConfigQuery`
   for the defaults enrolling offers, is the first.
5. **An ACL adapter dispatches; a handler still doesn't.** ADR 3's decision
   1 and ADR 6's decision 4 hold for a module's own messages: a command or
   query never imports another message, handler or use-case. Reaching
   another module is the exception, and its one sanctioned way: the handler
   asks its module's ACL port, and that port's adapter dispatches the other
   module's published query. The handler names neither the other module nor
   the message.
6. **The composition root provides an owner beneath its askers.** A module's
   ACL adapter requires the owner's query registrations, so `main.ts`'s
   `AppLive` provides the recipes module beneath the modules above it. The
   reference's `<module>.module.ts` wiring plane, where a module provides the
   modules it imports, waits for a second edge.
7. **The `repo-config` campaign counts what's left.** It holds each file
   under `src/` that imports `src/repo-config.ts` in a ledger that may only
   shrink. Each consumer moves onto an owner's repository or an ACL port of
   its own, a consumer or two per pull request; the composition roots
   dispatch the owners' queries. When none is left, `src/repo-config.ts` is
   deleted with its baseline entry and every allowance naming it.

## Enforcement

- The module-wide deny refuses a module naming anything of another but its
  `*.exports.ts`; `*.exports.ts`'s `importedBy` admits only a peer's
  `*.imports.ts` (and tests and the test harness); `*.imports.ts`'s admits
  only its module's ACL adapters.
- `*.exports.ts` carries the naming rule and the no-re-export rule, each with
  its probe.
- `domain/ports/acl/*.acl.ts` declares no value, requires its live, fake and
  live test, and is read only by its module's commands, queries and
  infrastructure (`acl-port-consumers`).
- `infrastructure/acl/` names only its module's `*.imports.ts`, its ACL
  ports, the value objects and errors they speak in, effect and the CQRS
  library.

## Consequences

- Enrolling reads the team's config through the recipes module. That read
  decodes only the keys enrolling weighs, so a team config with an unrelated
  mistake no longer stops `enroll`; the daemon, which still loads the whole
  file through `repo-config.ts`, reports it.
- `CheckoutsClient` reads a checkout's tree (its root, its repo and its
  flows) and no longer the team's config.
- Until the campaign finishes, `repo-config.ts` keeps its allowances, and
  `modules/{module}/`'s `importedBy` still names it.
