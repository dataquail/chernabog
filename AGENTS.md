# Chernabog

A daemon that runs agent sessions (Claude, Codex, …) on a repo's issues and pull
requests, on a schedule, as one or more GitHub personas. Bun, TypeScript, Effect v4.

## Before you finish

`bun run format:check`, `bun run check`, `bun run lint`,
`bun run lint:architecture` and `bun run test` must all pass.

The pre-commit hook (`.husky/pre-commit`, installed by `bun install`) runs them
in that order through `bun run precommit` and refuses the commit at the first
failure, in the main checkout and in a linked worktree alike. It only checks:
`bun run format` applies Prettier. `HUSKY=0 git commit …` skips the hook for a
work-in-progress commit you will fix before pushing; never `--no-verify` one
that you push. CI's build and its tests of the binary stay in CI.

`bun run test` runs the test files in parallel worker processes;
`bun run test:unit` leaves out the acceptance tests, and
`bun run test:acceptance` runs only them. `test/acceptance/timings.json` holds
each acceptance file's duration: CI splits the files across runners by it, and
`--parallel` starts the slowest first. Refresh it after adding or slowing a
file with `bun run test:acceptance --update-timings`.

oxlint's `curly` rule requires a braced block for every if, else and loop body,
which Prettier then breaks onto lines of its own. Run the full suite with no
edits in flight; one that overlaps an edit fails spuriously.

## Hard rules

- **Chernabog never runs Claude with `-p` / `--print`.** Every agent session it
  starts is interactive, through a launcher (orca, tmux, or the person's own).
  This is a billing constraint, not a style choice.
- **Never kill processes by name** (`pkill claude` and the like). Target the PID
  or launcher handle you captured.
- **Multi-PR work is a `gh stack`.** Read `gh stack --help` (or your agent's
  gh-stack skill, if it has one) before any stack command, and always use the
  non-interactive forms (`gh stack view --json`, `gh stack submit --auto`).

## Personas (#49, PR #56)

One daemon acts as several GitHub logins. Everything that touches GitHub must
act as the right one.

- `Persona = Option<string>` (`src/kernel/persona.value-object.ts`). `none` is the _implicit_
  persona: whoever `GH_TOKEN`, `GITHUB_TOKEN` or gh's active account is. Machine
  config without `github:` behaves exactly as before personas.
- **Tokens only via `GitHubTokens`** (`src/platform/github-auth.ts`), which runs
  `gh auth token --user <login>` with the ambient `GH_TOKEN` stripped. Never read
  `GH_TOKEN` directly. Child processes get the persona's environment from
  `childEnvironment(persona)` / `execOptionsFor(persona, { cwd })`; git pushes
  authenticate through the credential helper in `gitCredentialEnv` (https origins
  only).
- **API:** `GitHubApi.layerFor(persona)`; `GitHubApi.layer` is the implicit one.
- **One workflow per (repo, flow), shared by every persona.** The persona rides
  in the workflow payload (`FlowPayload.persona`); a resumed run without one uses
  its run row's persona (`flowLayer` in
  `src/modules/runs/infrastructure/runtime/engine.ts`). Per-persona services
  are built by `repoServices(…, persona)` / `buildRepoContext(…, persona)`.
- **The daemon schedules each (persona, flow)** and names it `repo/flow@login`.
  A flow several personas run should route its items (#204): its trigger
  leaves one for others by setting `elsewhere` to why, as the SDK's
  `Routing` does by `assignee` / `reviewRequested: "@me"` in the flow's
  settings. The engine only reads the reason; claims keep runs apart.
  `review`, `re-review` and `address-review` filter in their triggers, by the
  persona's login.
- **Run ids are random UUIDs.** The `om_runs` row is the record of what a run
  does and as whom; show runs with `runLabel` and `shortRunId`, and resolve user
  input with `resolveRunId` (unique prefix).
- **Known gaps:** the commit author isn't set per persona (the pull request
  author is right, since the persona's token opens it), and ssh origins push
  with the person's own key, not the persona's token.

## Per-persona settings (#50)

Each person's choices live in machine config, not the checkout. `local.yaml` is
no longer read.

- **A repo entry is keyed by `repo:` (owner/name)**; `path:` is only where the
  checkout is now. `EnrolledRepoRootOps.entryFor` finds one (slug, then
  `name`, then path, for two clones); `enroll` updates only the keys a
  checkout gives, so settings survive a re-enroll or a moved checkout.
- **`personas:` is a map of login → `PersonaEntry`** (`src/repo-config.ts`). The
  repo entry's `PersonaChoices` (`account`, `agent`, `roles`, `flows`,
  `schedule`, `activeHours`, `launcher`, `enabled`) are defaults; a persona's
  keys replace them whole (`EnrolledRepoRootOps.choicesOf`), so its `flows` replaces the repo
  entry's. Without `github:`, the repo entry's settings run the implicit persona.
- **A flow runs only if listed** in the persona's (possibly inherited) `flows`
  and not `enabled: false` (`flowOff`). The team's `flows.<flow>.enabled` and
  `runners` are only the defaults `enroll` offers (`EnrolledRepoRootOps.teamOff`),
  never runtime gates.
- **Missing checkout:** the daemon shows the repo as `missing` and keeps its
  settings; `init` offers to re-point an entry whose path is gone
  (`ListMovedReposQuery`, `RepointRepoCommand`); `unenroll` removes one
  (`UnenrollRepoCommand`).
- **Migration** (`src/migrate.ts`) runs before any command reads machine
  config: persona lists become maps, and an entry that lists no flows gets the
  ones that ran before plus `local.yaml`'s settings. It prints what it
  changed to stderr and leaves `local.yaml` for the person to delete.

## Setup and enrollment (#51)

`chernabog setup` (run by `install`) picks GitHub personas and AI accounts
(the machine module: `planSetupUseCase`, then `applySetupUseCase`, with
`src/interface/cli/machine/setup.command.ts` asking between them); `init` and
`enroll` run the enrollment wizard: `PlanEnrollmentQuery`, the questions in
`src/interface/cli/enrollment/enroll.command.ts` (personas, then for each
persona its flows and then its accounts), then `ApplyEnrollmentCommand`, which
resolves what wasn't answered and writes the entry once. The machine's
personas and accounts come in from the machine module's
`readMachineSetupUseCase`.

- **Every question goes through `Asker`**
  (`src/interface/cli/asker.prompt.ts`): `pick`, `choose`, `text`. Only an
  adapter asks: a wizard is a _plan_ use-case that returns the choices and an
  _apply_ use-case that takes the answers. `Asker.layer` prompts only when
  stdin and stdout are terminals; `Asker.none` is no one to ask. Check
  `asker.interactive` before asking; an answer not given is none, and the
  apply use-case takes the current choice, then the default, or fails.
- **Every interactive choice has a flag** (`--persona`, `--account`, `--flows`,
  `--defaults`), and a question with one possible answer isn't asked.
- **Tests answer with `scripted(answers)`** (`test/asker.ts`), which also
  records what was `asked`, rather than driving a TTY.

## Recipes (#67, #129)

`chernabog init` scaffolds no flows. A **recipe** is a complete flow from a
**recipe package**, an npm package a repo installs in `.chernabog/` with bun.
A repo copies a recipe (`init --recipes`, `chernabog recipes add`), and the
file is its own from then on, or imports it (`recipes add --import`, which
writes `flows.<name>.from` in config.yaml), and it runs from the package.

- **The binary bundles no recipes and no list of them.** `packages/recipes/`
  is `@chernabog/recipes`, released on its own release-please component. Its
  `package.json` lists its recipes under `chernabog.recipes`: the format any
  recipe package uses (`src/kernel/recipe-package.value-object.ts`, documented
  in `website/src/content/docs/recipes/packages.md`). The base scaffold is
  `templates/.chernabog/`; run `bun scripts/gen-templates.ts` after changing it.
- **The recipes module** reads installed packages through
  `RecipePackagesClient` (bun, with the repo's `.npmrc`), files through
  `ChernabogDirClient`, `flows.<name>.from` through `FlowImportsRepository`,
  and what the binary bundles (the scaffold, the pins) through `BundleClient`.
  `init` runs `addRecipePackageUseCase`; `recipes` runs `list`, `add`,
  `import`, `eject`, `diff`, `update` and `upgrade` use-cases.
- **Copied files record where they came from**, under `chernabog.copied` in
  `.chernabog/package.json`. `recipes diff` compares a copy with that version;
  `recipes update` merges the package's changes in 3-way (`git merge-file`).
- **Imported flows** are resolved by the loader (`src/platform/flow-loader.ts`)
  from `.chernabog/node_modules`. `checkInstalled` refuses a repo whose
  imported package isn't a dependency, isn't the version `bun.lock` pins, or
  doesn't support the repo's SDK or this binary's core. Core's `FlowPackage`
  (which `flowLayer` provides) makes prompts and steps look in the repo, then
  the package.
- A recipe is written out from SDK **blocks**, trigger included, so its
  policy is in the repo's file. The SDK exports no whole workflows or
  review-loop triggers; add a block rather than hide a decision in one.
- This repo's own `.chernabog/flows/` are copied recipes. Keep them in step
  with `packages/recipes/` (`chernabog recipes diff`, from a sandbox, shows
  where they differ).
- **Activity names are journal keys**: a run in flight resumes by them, and a
  package version reaches every repo that imports it at once. Keep a recipe's
  step names when you change it, and never rename one in a block.
- `@chernabog/recipes`' `@chernabog/sdk` peer range must include the SDK
  released with the binary, `packages/sdk`'s version (a test checks).
- The acceptance sandbox runs a local npm registry (`test/acceptance/fake-registry.ts`)
  that packs `packages/recipes/` and `packages/sdk/`, so bun installs for real
  with no network. It serves itself, so never install from it synchronously;
  a sandbox's committed `bun.lock` comes from a child process with a registry
  of its own (`test/acceptance/lockfile.ts`).
- Each recipe has a docs page, `website/src/content/docs/recipes/<name>.md`,
  which its `docs` links to.

## Architecture (goodbones)

`src/` is moving to use-cases over a domain of aggregates, invoked by inbound
adapters, with persistence and external systems behind ports (the plan's
settled decisions are recorded in `docs/adr/`). `architecture.yaml` is the
policy, and [goodbones](https://dataquail.github.io/goodbones) enforces it: the
`architecture/*` oxlint rules run in `bun run lint`, one file at a time, and
`bun run lint:architecture` adds the whole-graph rules (cycles, orphans,
transitive reach), the coverage floors and the baseline.

- **The layout.** `src/modules/<module>/` holds `domain/<aggregate>/`
  (`x.root.ts`, a `Schema.Class`; `x.root-ops.ts`, pure functions returning
  `Result`; `.id.ts`, `.errors.ts`, `.value-object.ts`),
  `domain/ports/{repositories,clients}/` (a `Context.Service` and its shape, no
  values), `commands/` and `queries/` (per message, a `<verb-noun>.command.ts`
  or `.query.ts` declaring it and its result schema, and a
  `<verb-noun>.handler.ts` exporting one `<verbNoun>Handler`), `use-cases/`
  (one `<verbNoun>UseCase` per `<verb-noun>.use-case.ts`, its result schema in
  `.result.ts`, until each moves), `infrastructure/{repositories,clients}/`
  (`-live.ts`, `-fake.ts`, `.mapper.ts`), `<module>.layer.ts`, and
  `<module>.command-handlers.ts` / `<module>.query-handlers.ts`, which
  register the handlers over the layer and declare the module's dispatchers
  (`TrustCommands`, `TrustQueries`), provided in `main.ts`'s `AppLive`. Shared
  primitives live in `src/kernel/`, inbound adapters in `src/interface/`.
  Filenames are dot-delimited stereotypes, kebab-case in front.
- **What reaches what.** The domain names effect, the kernel and its own
  module's domain. A use-case adds its ports; it never names infrastructure or
  interface, never prints, prompts or sets an exit code, and returns a typed
  result an adapter renders. Only repository adapters (and the legacy tier)
  name `yaml`; only the runs module's infrastructure and the engine name SQL.
- **Obligations.** A `.root-ops.ts`, a `.use-case.ts` and a `.handler.ts` each owe a sibling
  `.test.ts`; a repository or client port owes its `-live.ts`, `-fake.ts` and
  `-live.test.ts`. The lint names what is missing.
- **Enrollment is the first module.** `EnrolledReposRepository` loads and saves
  an `EnrolledRepoRoot`: its machine-config entry (edited in place, comments
  kept, and written only when the entry changed) and whether it's paused
  (`paused.json`, by slug, so clones of one repo pause together). `pause` and
  `resume` are use-cases the CLI (`src/interface/cli/enrollment/`), the TUI
  and the daemon's gate all go through.
- **Trust is its own module**, apart from the config a person edits:
  `TrustRecordRoot` (the tree of `.chernabog/` a person approved, in
  `trust.json` by slug) behind `TrustRecordsRepository`, and git behind
  `ConfigTreeClient`. It is the CQRS worked example (ADR 6): adapters ask
  `TrustQueries` and `TrustCommands`. `TrustRepoCommand` is a security gate,
  so only the CLI dispatches it; never expose it to an agent-facing adapter
  such as MCP. The daemon and `doctor` read trust through
  `FindTrustedTreeQuery`, `status` through `CheckTrustQuery`.
  `ReloadRoot` (`reloaded.json`, by slug, behind `ReloadsRepository`) is the
  tree each repo last restarted the daemon on: the daemon restarts on a
  trusted tree only when `ClaimReloadCommand` says it's the first time, so a
  trusted tree that fails to load restarts it once, not on every check.
- **Runs are the runs module's.** `RunRoot` (`om_runs` in `state.db`) keeps
  its lifecycle in `RunRootOps`: it starts running, takes steps while it runs
  and ends exactly once, and a persona has one run in flight per flow and item.
  `RunWaitRoot` (`om_waits`, with when it parked) parks a run on a signal;
  `RunStepRoot` (`om_steps`) logs each step a run enters, which
  `enterStepUseCase` writes beside its current step; `SkipRoot` (`om_skips`)
  logs why a tick started nothing. A run's `subjects` (`om_run_subjects`)
  are the work items it named with core's `Subjects.name`, such as the pull
  request an SDK block opened or adopted; the engine records them through
  `nameSubjectUseCase` and knows nothing of what they mean. The live view
  threads runs that share a work item, as their own or as a subject, and a
  flow's `stillValid` gets them as `Run`'s `subjects`. The engine, the daemon and `chernabog run`
  record and read them only through the module's use-cases
  (`startRunUseCase`, `enterStepUseCase`, `finishRunUseCase`, …); a run's
  `RunView` is what crosses the socket. `RunsRepository.save` never rewrites a
  run that ended with another ending, so a stale copy can't revive it.
  `RunId`, `shortRunId` and `runLabel` are in `src/kernel/run-id.id.ts`.
  The flow rules the daemon decides by are the runs module's domain too, as
  value objects with their tests: `schedule/` (which cron expression a
  persona's flow ticks on, next ticks, active and quiet hours, and
  `decideTick`/`freeSlots` in `tick.value-object.ts`), `routing/` (whose work
  items a persona's flow starts here) and `usage/` (`decideLaunch`, the usage
  gate's decision).
- **A tick is a plan, applied by the daemon.** A use-case never calls another
  use-case (`architecture.yaml` forbids it); what several do together, the
  composition root that calls them composes. `planTickUseCase` is one tick of
  a persona's flow up to what it would do: the machine's gates, the trigger,
  routing and the concurrency limits, recording a skip when it would start
  nothing. It returns a `TickPlan`: the work whose signals go to runs in
  flight, and the work to start runs for. The daemon then delivers the
  signals (`deliverSignalsUseCase`) and, item by item, asks the flow's own
  gate (`gateFlowUseCase`, before every start, since a started run may close
  it) and starts the run (`startFlowRunUseCase`). The daemon polls each
  active run with `pollRunUseCase`. Flows run through `FlowsClient`
  (trigger, item lookup, gate) and workflows through `WorkflowsClient`
  (execute, poll, resume, wake, note); the daemon and `chernabog run` build
  both from the flows they loaded (`RuntimeLayer(registry)` in
  `runs.layer.ts`) and pass in what other modules know, such as whether the
  repo is paused.
- **A start survives a crash.** A run is recorded, with the work item it is
  for, before its workflow executes, so a process killed in between leaves a
  run with no execution. `recoverRunsUseCase`, which the daemon and
  `chernabog run` call at startup, executes those from the item they kept and
  attaches the execution. An execution is keyed by its run, so one that had
  started is the one attached, never a second (`test/engine.test.ts` covers
  both windows). A run from before runs kept their item ends as failed, so
  its item can start again.
- **Stopping is bounded.** `main.ts` wraps the program in
  `withShutdownDeadline` (`src/platform/shutdown.ts`): after SIGINT or
  SIGTERM the finalizers get 3 seconds, then the process exits; a second
  Ctrl-C exits at once. Keep finalizers to bookkeeping (the socket, the lock,
  a log line). Never make correctness wait on a clean stop; recover at
  startup instead.
- **State files are changed under a lock and replaced whole.** Machine
  config, `paused.json` and `trust.json` are changed with `updateFile`
  (`src/platform/file-lock.ts`). It holds `<file>.lock`, re-runs the change if
  an editor saved the file meanwhile, and replaces the file atomically with
  `writeFileAtomic` (`src/platform/atomic-write.ts`). Use `updateFile` for any
  new state file; a repository adapter may not call `writeFileString`. An
  update isn't reentrant: never call one inside another on the same file.
  Run logs are behind `RunLogsClient`: `resolveRunIdUseCase` names a run by
  a prefix of its id, and `followRunLogUseCase` is a `Stream` of what a log
  gains, ended by an effect the caller passes, since only the caller knows
  who to ask whether the run finished (the CLI asks the daemon).
- **The daemon is an adapter too.** `src/interface/daemon/` holds its
  socket protocol (`daemon.protocol.ts`, made of the modules' results) and
  the client the CLI and TUI ask it with (`daemon.client.ts`). The CLI's
  `status`, `logs` and the rest print a use-case's result, and with `--json`
  print it through its schema instead (`printJson` in
  `src/interface/cli/cli.output.ts`).
- **The machine module** owns this machine's setup: `MachineSetupRoot`
  (`github:` personas and `accounts:`, edited in place in machine config),
  gh's logins, the account directories in the home, and the daemon as a
  launchd or systemd service (`ServiceManagerClient`). `applySetupUseCase`
  refuses to drop a persona an enrolled repo runs as; the CLI passes
  enrollment's `ListPersonasInUseQuery` in, since modules don't read each
  other.
- **A use-case doesn't talk.** The `no-talking` members rule reports a call to
  `log`, `warn`, `exit`, `pick` or `choose` in `use-cases/` and `domain/`.
- **Modules don't reach into each other.** An adapter composes them: the
  `trust` command lists its targets with enrollment's
  `ListEnrolledReposQuery`, then trusts each.
- **The platform** (`src/platform/`) holds the technical adapters everything
  shares: `exec.ts`, the host environment, `home.ts`, `github-api.ts` and
  `github-auth.ts`, `agent-accounts.ts`, `self.ts`, `version.ts`, the
  engine's `lock.ts`, `config-error.ts`, and a repo's `.chernabog/` as code:
  `flow-loader.ts`, `config-snapshot.ts`, `flow-deps.ts` and the generated
  `templates.ts` and `effect-modules.ts`. It names effect, node, core, the
  kernel and itself, nothing else.
- **The composition roots are adapters too**: the CLI's
  `src/interface/cli/main.ts`, the daemon's `src/interface/daemon/daemon.server.ts`
  and the live view in `src/interface/tui/`. Each has its own allowlist in
  `architecture.yaml`, which names, file by file, the legacy runtime it still
  drives; moving a file into a module takes it off those lists.
- **The runtime** a run's flow executes in is the runs module's
  `infrastructure/runtime/`: the workflow engine and step runner, core's
  services over GitHub, git, worktrees and usage, and the agents and
  launchers. They adapt core's ports, report a run's steps and
  waits back through the module's use-cases, and name no interface or other
  module.
- **A command that composes the runtime itself** is a `*.main.ts` beside the
  commands (the foreground `run`, `start`, `open-pr`, `doctor`), a
  composition root of its own under the `cli-root` allowlist, as `main.ts` is.
- **The legacy tier** (the flat `src/*.ts` still left: machine config and its
  migration, and the effective repo settings in `repo-config.ts`) is one
  `unrestricted` node. Why those two are left, and the decision that moves
  them, is in `docs/adr/0002-the-sweep-into-modules.md`. A migration moves files out of it and
  ratchets `limits` in `architecture.yaml`: raise a coverage floor or lower a
  ceiling when the numbers move (`bun run architecture:coverage`,
  `architecture:conformance`), never the other way to make a run green.
- **The baseline** (`.architecture-baseline.json`) is debt, not a suppression
  list: a fixed violation fails until its line is gone
  (`bun run architecture:baseline`). Prefer fixing, or a reason written into
  the manifest, to adding a line.
- **Campaigns** (`campaigns:` in `architecture.yaml`) count a refactor still
  under way. `cqrs` moves each use-case to a command or query; its ledger in
  `.architecture-campaigns/` lists the use-cases left, and may only shrink.
  A change that moves one runs `bun run architecture:clear` and commits the
  ledger with it; `bun run architecture:campaigns` shows what's left. Always
  clear through the script: a bare `architecture objectives clear` walks
  `packages/`, finds no module, and closes every holdout. Never
  `objectives concede` to make the gate pass; a use-case the campaign counts
  again is one a change brought back.
- **Every rule carries a probe**, and the plugin refuses to load a rule that
  can't fire. To change the policy, edit `architecture.yaml` (the
  `yaml-language-server` schema completes and checks it), plant the violation
  you mean to catch, and see it reported. `bun run architecture:explain <file>`
  shows every rule that governs a file.

## Errors (#75)

Errors split by who acts on them (`packages/core/src/errors.ts`).

- **A flow fails only with its outcomes**, `Skip | NeedsHuman | StepFailed`
  (`FlowError`), in `trigger`, `gate`, `item` and `workflow` alike. Anything
  else must be handled first, and the compiler says so.
- **Work errors** (`NotFound`, `PullRequestClosed`, `MergeRefused`,
  `PushRejected`, `NothingCommitted`, `CiTimedOut`) are typed on the service
  method or block that raises them, survive `activity` (they're journaled), and
  the recipes decide what each means. Add one only for something a flow can
  decide on; a failure it can only report stays `GitHubError` and the like,
  which `activity` and `reportAs(step)` turn into `StepFailed`.
- **Setup errors** (`PersonaUnavailable`, `NotAuthenticated`,
  `NotInReviewerPool`) come from building a persona's services
  (`repoServices` in the runs module's runtime, `checkPersona` in
  `src/platform/github-auth.ts`), never from a flow. Each persona's build
  result is kept (`buildPersonaContexts`) and a failed one is rebuilt when next
  asked for. `FlowsClient` reports one as `PersonaNotReady`, which
  `planTickUseCase` records as the tick's skip reason as it stands, fix
  included.
- **A capability's setup is a service.** `ReviewerSeat` is checked at build
  but raised only when a flow asks for it (as a defect `surfaceSetup` turns
  back into the setup error), so flows that never review run regardless.

## Markers (#143)

A marker is something a run put on an item outside chernabog (a label, an
assignment, a board Status, a claim ref or branch), with a named release.

- **The flow side** is `packages/core/src/run-markers.ts` (exported as
  `Markers`): `define(name, argsSchema, release)`, `hold`, `drop`, `dropAll`,
  `forget`. A hold goes through the `MarkerHolds` service the engine provides
  (`flowLayer`), and does nothing outside a recorded run. A flow lists its
  definitions in `defineFlow({ markers })`; core's own
  (`github-markers.ts`, plus `Claims.refMarker`) are `Markers.builtIn`. Keep a
  marker's name and arguments' shape once runs hold it: a run in flight is
  released by them.
- **The runs module** keeps holds as `RunMarkerRoot` (`om_markers`), one per
  run, name and arguments. `releaseMarkersUseCase` releases what ended runs
  hold, newest first, through `FlowsClient.releaseMarker` (the loaded flow's
  definition, as the run's persona); keepOn endings are kept, a failure backs
  off (`RunMarkerRootOps.backoff`), and a missing definition is unreleasable.
  The daemon runs it every few seconds, `chernabog run` once its run ends, and
  `status` shows `listUnreleasedMarkersUseCase`.
- **Cancel still does its own cleanup** (claim ref, assignment, branch) for
  runs from before markers; markers' releases are safe to repeat after it.
  Labels are the flow's: cancel never removes one, and a run's label marker
  releases it (#207).

## Flow settings (#202)

Core's settings are the engine's; everything else is a flow's
(`docs/adr/0005-the-engine-knows-no-workflow.md`, decision 6).

- **A flow declares its settings** with a schema, `defineFlow({ settings })`,
  and reads them with `Settings.read(schema)` (core's
  `packages/core/src/flow-settings.ts`), through the `FlowSettings` service
  the engine provides: `flowLayer` for a run, `FlowsClientLive` for a
  trigger, item, gate and stillValid, `declaredLabels` for `chernabog labels`.
- **The input is merged** in `src/repo-config.ts`: config.yaml's `settings:`
  (`PersonaRepo.shared`), then `flows.<name>.settings`, then the persona's
  `flows.<name>.settings` in machine config (`mergeFlows`), key by key, an
  object one level down (`mergeSettings`, `flowSettingsInput`).
  `checkFlowSettings` decodes each flow's schema for each persona wherever a
  repo's flows load beside its config, so a bad setting is a `ConfigError`.
- **The SDK's shared settings** are `packages/sdk/src/settings.ts`: schemas a
  recipe spreads into its own (`Settings.Ci.fields`, …) and readers its blocks
  call (`Settings.ci`, `labels`, `localGate`, …). A reader falls back, key by
  key, to Repo's deprecated fields, which config.yaml's old top-level keys
  still fill. Each bundled recipe declares the blocks it reads and
  `labels: Settings.declaredLabels`.
- **Labels are the flows'.** `chernabog labels` and `doctor` create and check
  what the loaded flows declare (`labelsOf`, which may work them out from
  settings); `src/` has no label set of its own.
- **Kept until core's next major** (core only grows within one, ADR 0004):
  core's `Labels`, `DEFAULT_LABELS`, `Limits` and RepoSettings' recipe keys,
  and config.yaml's old keys, which a flow's settings fall back to.
  `reviewTrigger` still loads and does nothing. The engine still reads the
  reviewer pool (`ReviewerSeat`), the board (`queuedIssuesLabelled`) and,
  for the deprecated `queuedIssues` and `oldestQueued` alone, the label
  names from Repo, which `mergePersona` fills from `settings.reviewers` and
  `settings.board` when the old keys are unset, and from `settings.labels`
  over the old `labels:`.
- **CI is facts (#207).** `GitHub.ciChecks` reports every check run and
  commit status on a pull request's head and whether its base requires it,
  with no verdict; the SDK's `Ci.verdict` decides, by the flow's `ciGates`
  and `ciOptionalFailures` (`Settings.Ci`, read by `Settings.ciGate`).
  `ciState` (which now counts commit statuses too) and `commitCiState` keep
  their verdicts, deprecated, until core's next major; no SDK block calls
  `ciState`, `queuedIssues` or `oldestQueued`.
- **config.schema.json** describes each flow's settings from its schema
  (`configSchemaWith` in the recipes module's `BundleClientLive`), written by
  `scaffoldRepoUseCase`, which `init` and `recipes add`, `update` and
  `upgrade` run again once the flows changed.

## Rehearsals (#115)

`chernabog rehearse <flow> --scenario <file>` runs a repo's own flow file down
the real path (machine config, personas, routing, pool, real GitHub and CI) on
a seeded repo, with no agent session.

- **Stand-ins, not a second flow.** `activity()` names its step in
  `CurrentActivity`, and `AgentLive` passes it on as `AgentRequest.step`. The
  `rehearsal` adapter (`agents/rehearsal.ts`) answers each step from
  `standIns` (`src/kernel/stand-in.value-object.ts`): a script in the
  worktree, or a fixture with placeholder commits. `exclusive: true` sends
  every agent call to it, so no real agent can start. A step it can't answer
  is recorded (`recordUnanswered`) and fails the rehearsal whatever the flow
  did about it; the step's own block still checks the answer's shape.
- **Every agent answer is recorded** by step, with the commits its step made
  (`agents/answers.ts`, `sessions/runs/<run>.answers.jsonl`). That's what
  `--replay <run>` stands in with.
- **The rehearsals module** reads scenarios (`ScenariosRepository`; the file's
  shape is `src/kernel/scenario.value-object.ts`, and `init` writes its schema
  as `rehearsal.schema.json`) and seeds and cleans up GitHub
  (`ScratchRepoClient`). `rehearse.main.ts` composes it with the runtime: a
  clone of the scenario's repo, a journal of its own under
  `rehearsals/<id>/`, and only seeded work items (`chooseSeededWorkUseCase`).
- **An enrolled repo is refused** unless the scenario says `enrolled: true` or
  the person passes `--on-enrolled`; then it is paused on this machine
  meanwhile, and cloned from its own origin.

## Versions (#123, #163)

One binary runs every enrolled repo, so compatibility is the binary's call.
docs/adr/0004-core-abi.md has the why.

- **Two packages.** `@chernabog/core` (`packages/core/`) is the contract: the
  flow shape and the hooks the daemon calls, the durable primitives, the
  errors, the ports, claims and markers. `@chernabog/sdk` (`packages/sdk/`) is
  the blocks, over core, and re-exports core. The binary imports core only:
  `daemon-reaches-no-sdk` in `architecture.yaml` fails a route from `src/`
  into the SDK's code, tests included. Something the daemon itself acts on
  belongs in core.
- **The binary provides core; each repo installs its SDK.** The loader
  substitutes the binary's `@chernabog/core` and `effect`; the SDK resolves
  from the snapshot's `node_modules`, which `installFlowDependencies` installs
  from `dependencies` and the lockfile. In tests, `installWorkspaceSdk`
  (`test/workspace-sdk.ts`) links `packages/sdk` into a fixture's
  `.chernabog/node_modules`.
- **The installed SDK's core range is the contract.** The binary runs a repo
  when a core in `PROVIDED_CORE` (`src/kernel/core-support.value-object.ts`)
  satisfies it. `checkCompatibility` (`src/platform/flow-deps.ts`) refuses,
  before installing, a repo without the SDK in `dependencies`, with
  `engines.chernabog`, typed against a core this binary doesn't provide, or
  whose flows import from core what it lacks; `checkInstalled` refuses one
  whose installed SDK needs another core, or whose imported packages don't
  fit its SDK. Both fail with `IncompatibleConfig`; the daemon shows it as
  `incompatible`. `upgradeRepoUseCase` (`chernabog recipes upgrade`) moves a
  repo to the SDK released with the binary (`RELEASED_SDK`) and pins core and
  effect.
- **Core only grows within a major** (ADR 0004): add to a port, never change
  one; never touch the durable primitives, the hooks, or a claim's or
  marker's name and arguments. `packages/core/API.md` is what `tsc` declares
  of core: run `bun run gen:core-api` after changing core, and read the diff
  as a reviewer would. CI's `published` job loads the oldest and newest SDK
  on npm that claim this core, with their recipes
  (`test/published-compat.test.ts`, `CHERNABOG_PUBLISHED=true`).
- **Local state is stamped, backed up and refused.** Machine config's
  `chernabog:` key and `state.db`'s `om_meta` hold the version that last
  migrated them (`src/migrate.ts`, `state-stamp.ts` beside the engine). Any
  older stamp is copied to `backups/` first (`src/platform/backups.ts`); a
  newer one is refused with restore instructions. There are no down
  migrations.
- **Runs record their core and their tree** (`om_runs.core_version`,
  `om_runs.config_tree`). `flowLayer` never runs a flow for a run whose core
  this binary can't resume (`resumesRunsFrom`: the same major, at that
  version or later), and the daemon ends such runs at startup through
  `cancelRunUseCase` with `needsHuman`. A run resumes against the snapshot of
  the tree it started from (`flowOrigins`, `snapshotTree`), so a merge or an
  SDK move never swaps its blocks. When its executable changes, the daemon
  drains: no ticks, `/run` refused, and a restart once no run is executing
  (parked runs don't count).

## Effect and lint

`bun run lint` is strict: oxlint's rules (`.oxlintrc.json`, including the
anti-slop plugins in `tools/oxlint/`) plus the Effect language service's
diagnostics, reported as `effect(<rule>)`. The ones you'll hit most:
`effect(noTernary)` (use `Option.match` or `Match`), `effect(noNullish)` (no
`null`/`undefined` in types; use `Option`), sorted imports (`bun run lint:fix`)
and a cognitive complexity cap (extract a function). Fix the cause rather than
disabling the rule.

- `Effect.provide` closes the resources of the layer it provides. Build a
  layer per test, don't share one across `Effect.provide` calls.
- Services are `Context.Service`; to get one as an effect, use
  `Service.use(Effect.succeed)`. There's no `.asEffect()`.
- Comments are plain sentences that say what a thing is for, and why when
  that's not obvious. Match the density of the file you're in.

## Tests

- Unit tests sit beside the source (`src/*.test.ts`) or in `test/`. Engine
  tests use the fakes in `test/sdk-fakes.ts`; `effectAtHome` (`test/effect-test.ts`) gives a test a
  scratch chernabog home.
- **Acceptance tests** (`test/acceptance/`) run the real CLI and daemon in a
  sandbox (`openSandbox(repoConfig, { github, personas })`) against
  `fake-github.ts`, which takes the login from the bearer token and records who
  made each request (`requestsBy`). `test/fakebin/` puts fake `gh`, `claude` and
  `codex` on the PATH: `gh auth token --user <login>` answers `token-<login>`,
  and the agents log the token they saw. Extend these rather than mocking
  modules (module mocking is a lint error).

## The redesign in flight

Issues build on each other; implement them in order, each as a `gh stack`
layer on the one below, and read the issue _and_ the PR beneath yours first.

1. #50 per-persona settings in machine config, `local.yaml` retired
2. #51 install and enrollment wizards
3. #52 TUI overrides
4. #53 reviewer pool, `review`, `re-review` (starts after #50 settles config)
5. #54 `address-review`
6. #55 hybrid path, `chernabog start`

Decisions that cut across them:

- Chernabog merges only pull requests labelled `auto:ship`; everything else is
  merged by a person.
- `auto:needs-human` is the one hand-off to a person; review flows skip
  pull requests that carry it.
- Breaking config changes are fine (only this repo and goodbones use
  chernabog), but each one gets a migration that rewrites machine config and
  says what it changed.

### Review flows (#53, #54)

- `settings.reviewers` in the team's config (once `reviewers:`) is the pool. `Implement.handOff` calls
  `PullRequest.requestReview`, which picks one at random, never the author,
  inside an activity so a replay asks the same login; no pool means
  `auto:needs-review` for a person.
- `review` runs as a persona whose review is requested and who hasn't
  reviewed; `re-review` as one asked again, resuming
  its session with `Review.recheck` from the review marker (which records
  reviewer, sessionId and adapter). The `reviewRounds` setting (default 1)
  caps re-reviews.
- Merging goes through `PullRequest.merge`'s safety checks, and only for what
  `PullRequest.ships` (carries `auto:ship`), read once per run with
  `PullRequest.shipping`; the recipes do this, and `PullRequest.mergeOrLeave`
  is the same in one block. Otherwise hand to a person.
- `address-review` (`ownWork: true`) runs as the pull request's author persona, when the latest decisive
  review (APPROVED or CHANGES_REQUESTED) requests changes on the current head;
  item key `pr-<n>-changes-<count>`. It resumes the implementing session from
  the session marker, `Implement.considerFindings` first: "decline" posts the
  reasons and hands to a person, never pushing or re-requesting; "address"
  runs `Implement.addressFindings`, the local gate, push and CI, then
  re-requests the reviewer who asked. `re-review` skips `auto:needs-human`, so
  re-requesting mid-dispute doesn't restart the loop.
- A review request for a login no persona here acts as never fails; it
  waits (#76). The binary knows nothing of it (#208): what doctor and
  status say comes from the flows. `doctor` runs each flow's
  `defineFlow({ doctor })` checks (`flowWarnings` in
  `src/modules/runs/infrastructure/runtime/diagnostics.ts`) and prints their
  warnings (`!`, not a failure); the recipes that ask for reviews include
  `Review.poolCheck`, and the ones that review `Review.reviewerCheck`, which
  also marks them as reviewing for `poolCheck`. The review recipe's trigger
  reports each request no persona here serves as an item that `waitsOn` the
  login (`Review.waitingElsewhere`, from core's `Machine` service, which
  `buildRepoContext` provides); `planTickUseCase` starts none of those and
  returns them in `TickPlan.routed.waiting`, which `status` lists.
  `enroll` reads the untrusted checkout and imports no flow, so it says
  nothing of the pool.
- **`src/` names no recipe.** `local/no-recipe-names`
  (`tools/oxlint/local/`, scoped to `src/` in `.oxlintrc.json`) refuses a
  string that is a recipe's name and a regex over the SDK's vocabulary;
  learn what a flow does from what it declares through core instead.
- Gone: the `ship` composite flow, `Review.labelVerdict`/`reviewRound`,
  review's wait-for-push loop, and the `fix` flow (`Review.fixTrigger`,
  `fixWorkflow`, `FixItem`, the `fix` prompt), and the whole workflows and
  triggers `Implement.workflow`/`trigger`, `Review.workflow`/`trigger`,
  `reReviewWorkflow`/`reReviewTrigger` and `addressWorkflow`/`addressTrigger`
  (#67: the recipes write them out). `auto:approved`, `auto:stale`
  and `auto:changes-requested` stay in the label set but no default flow sets
  them.

### Claims (#133)

- **A claim is a ref of its own**, `refs/chernabog/claims/<item>`
  (`Claims.issue(n)`, `Claims.pullRequest(n)`), at an empty-tree commit whose
  message names the holder (run, persona, flow, claimed-at, with-person; never
  the machine, since the ref is as public as the repo). Creating it is the
  lock (`Claims.acquire`), reading it says who holds it (`Claims.holder`).
- **The work branch is just the work.** `Implement.claim` and `Hybrid.claim`
  acquire the claim ref, then create `auto/issue-<n>` or adopt one with no
  claim on it.
- **Release is a block, not the engine's.** The recipes wrap the run in
  `Claims.releasing(Claims.issue(issue))`, which deletes the ref however the
  run ends (a wait keeps it), as `PullRequest.owning` does for `pr-<n>`.
  The branch and any pull request stay; labels, assignee and claim comment
  are for people.
- **`chernabog cancel` lets a claim ref go**, on the run's issue or pull
  request (`RunCleanupClient.releaseClaimRef`, only a ref naming the run).
  A flow that doesn't wrap its claim in `Claims.releasing` (any baked before
  claims were refs) leaves its ref when the run ends; `cancel <run>` on that
  ended run deletes only the ref (`CancelledRun.alreadyEnded`), the run keeps
  its ending, and with no ref left it is refused (`RunAlreadyFinished`).
- **Claims are leases** (#134). The claim commit carries `Expires-At` (and
  `Renewed-At`, `Taken-Over-From`). GitHub checks no fast-forward outside
  `refs/heads/`, so a renewal or takeover (`Claims.renew`, `Claims.acquire` on
  an expired claim) first creates `refs/chernabog/leases/<item>/<sha replaced>`,
  which only one writer can; the winner then force-moves the claim ref
  (`GitHub.updateRef`) and deletes the lease ref, and readers (`Claims.current`)
  follow a lease ref a writer left. `acquire` holds the claim-ref marker only
  once it has won.
- **The daemon renews** each run's claim-ref markers through
  `checkRunLeasesUseCase` (`FlowsClient.lease`) every `limits.leaseRenewEvery`,
  for `leaseTtl` or `parkedLeaseTtl`, and reads them before each stillValid
  check; a claim naming another run ends the run as `lost` (`cancelRunUseCase`
  with `endAs lost`, which removes nothing). In the run, `fencing` in the
  engine checks `Claims.holds` before every write a capability port declares
  (`Capabilities.declare` beside each port in core's `services.ts`, listed in
  `CAPABILITIES`; the claim refs' own writes are declared `claim` and never
  fenced), and a lost claim ends the workflow as `lost`. `reportingChanges`
  reports the same writes. The engine names no port method: a new write, or a
  new port, is fenced and reported by declaring it. A lost run's markers are all kept: they
  are the taker's.
- **Migration, to drop a release later:** a branch whose latest claim marker
  has no `ref: true` is an earlier version's claim (`Implement.legacyClaim`),
  and a pull request with no claim ref falls back to its owner markers
  (`PullRequest.ownerOf`).

### Hybrid path (#55)

- No hybrid flow is scaffolded: `init` writes the same four defaults. The
  SDK ships only blocks (`Hybrid.trigger`/`itemFor`/`claim`/`workWithPerson`/
  `personSession`/`openPullRequest`/`handOff`; no `Hybrid.workflow`), and a
  repo writes its own `human-initiated` flow from them, as this repo's
  `.chernabog/flows/human-initiated.ts` does (`ownWork: true`, no gate). Its
  trigger finds nothing on a schedule; `chernabog start <issue>`
  (`src/interface/cli/runs/start.main.ts`) asks the daemon to run on
  `issue-<n>` the flow that declares `defineFlow({ start: true })`, as its
  status reports it (`startFlowOf` in `src/kernel/manual-flow.value-object.ts`
  refuses a repo with none or several, naming them). The optional `Flow.item(key)` finds an item the
  trigger doesn't report (`FlowsClient.find`, for the daemon
  and `run --item`). It then attaches to the session (`liveAttach`).
- `Hybrid.claim` takes the issue's claim ref like `Implement.claim`, and
  skips an issue another run holds. During the migration it still takes over
  a branch an earlier version's start claimed (`ClaimMarker.withPerson`), but
  not one an earlier unattended run claimed. One Claude session per
  repo+issue (`sessionIdFor(slug#issue, 'human-initiated')`), so a restart resumes it.
- `AgentRequest.withPerson`: only claude under an interactive launcher; the
  Stop hook gets `--person` and never blocks; the session stays open after
  answering; a session the person closes fails the call. The session's env
  carries `CHERNABOG_SESSION`, which `chernabog open-pr` (`src/interface/cli/runs/open-pr.main.ts`)
  uses to write the answer and `done` once the worktree is clean.
- `Hybrid.handOff` posts a `SessionMarker` with `withPerson: true`, so
  `address-review` reopens the person's session (consider, address, local
  gate and CI fixes). The pull request is labelled `labels.hybrid`, which no
  flow reads; it never carries `auto:ship`, so a person merges.
