# 2. Sweeping the rest of src/ into modules, and what's left

Status: accepted, 2026-10-23. Decision 1 superseded, and decision 3 amended, by
[ADR 3](0003-use-cases-dont-compose-and-recovery-over-clean-stops.md). The
decision "What's left" defers is settled for the gateway by
[ADR 9](0009-modules-import-and-export.md).

## Context

ADR 1 settled the shape: use-cases over a domain, behind ports, invoked by
inbound adapters, policed by goodbones. The first slices (enrollment, pause,
trust) were small. Moving the rest (runs, setup and enrollment's wizards,
recipes, the runtime that runs a flow, and the composition roots) meant
decisions ADR 1 didn't make.

## Decisions

1. **A module's use-cases may compose each other.** The tick starts runs,
   wakes waiting ones and records skips; those are use-cases of the same
   module. A use-case may import its module's other use-cases. It still may
   not import another module's. The cycles rule guards the rest.
2. **The runs module is the flows runtime.** A run's lifecycle, scheduling,
   gating, routing and the engine all orchestrate runs, so they are one
   module rather than `runs` plus `flows`. Its runtime adapters (the
   workflow engine and step runner, the SDK's services over GitHub, git,
   worktrees and usage, the agents and launchers) live in
   `infrastructure/runtime/`. They adapt the published SDK's ports, and
   report a run's steps and waits back through the module's own use-cases,
   as an inbound adapter would, so that bucket may call them.
3. **A tick is a use-case over two ports.** `tickFlowUseCase` runs flows
   through `FlowsClient` and workflows through `WorkflowsClient`. Both live
   adapters read a registry of the flows a process loaded. What other modules
   know (whether a repo is paused, whether its tree is trusted) is passed in
   by the adapter that composes them, the daemon, as ADR 1 has adapters do.
4. **Wizards are a plan, the adapter's questions, then an apply.** An answer
   not given is none, and the apply takes the current choice, else the
   default, else fails. The rules for that live in the domain's ops, not in
   the prompts. Only the CLI asks (`src/interface/cli/asker.prompt.ts`).
5. **`src/platform/` is the shared technical tier.** Commands, the host
   environment, chernabog's home, GitHub's API and tokens, the agents'
   account directories, this program's name and version, the engine's lock,
   `ConfigError`, and a repo's `.chernabog/` as code (its flows loaded, its
   trusted tree, its pins, the bundled scaffold and recipes). It names
   effect, node, the SDK, the kernel and itself, nothing else.
6. **Composition roots are adapters with their debt written down.** The
   CLI's `main.ts`, the daemon's `daemon.server.ts`, the TUI, and a command
   that composes the runtime itself (`*.main.ts`: the foreground run,
   `start`, `open-pr`, `doctor`) each have an allowlist. It names, file by
   file, the runtime and legacy files the root still reaches for. Moving a
   file into a module takes it off those lists.
7. **The ratchets only tighten.** When a move would have lowered a coverage
   floor, the policy was made to cover the moved files instead. When a floor
   was diluted by new files, a rule that earns coverage was added
   (`no-talking`: a use-case or domain file never logs, warns, exits or
   prompts) rather than lowering the floor.

## What's left, and why

`src/repo-config.ts` and `src/migrate.ts` are the legacy tier now. They are
machine config's file format, its migrations, and the effective settings a
run uses. The effective settings merge the team's `.chernabog/config.yaml`,
the machine's accounts and launchers (the machine module) and each persona's
choices (the enrollment module). Putting the merge in any one module would
make it reach into another's domain, which ADR 1 forbids.

This is the "modules start reaching into each other" case ADR 1 deferred
the module gateways for. The next step is a decision between:

- **A gateway**: enrollment exports a read model of a repo's persona choices
  (an `*.exports.ts`, as the reference does), which the runs module imports.
  The merge then becomes runs' own.
- **A query use-case composed at the roots**: the daemon and the foreground
  run assemble the effective settings from each module's use-cases and pass
  them in, as they already pass in pause and trust.

Either one also gives the file format a home: a shared storage adapter that
each module's repository edits through, typed by the modules' own mappers.

## Consequences

- Everything under `src/` except those two files sits in a module, the
  kernel, the platform or the interface, each under an import allowlist.
  Import coverage is 0.94 and structure coverage 0.85.
- The CLI's `status`, `logs` and `doctor` print a use-case's result, and with
  `--json` the same result through its schema.
- No MCP adapter yet (ADR 1, decision 7). When there is one, it offers a
  deliberate allowlist of use-cases, never `trustRepoUseCase` or setup.
