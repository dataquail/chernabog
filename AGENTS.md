# Chernabog

A daemon that runs agent sessions (Claude, Codex, …) on a repo's issues and pull
requests, on a schedule, as one or more GitHub personas. Bun, TypeScript, Effect v4.

## Before you finish

`bun run format:check`, `bun run check`, `bun run lint`,
`bun run lint:architecture` and `bun test` must all pass. `bun run format`
applies Prettier; oxlint's `curly` rule requires a braced block for every if,
else and loop body, which Prettier then breaks onto lines of its own. Run the full suite with no edits in flight; one that overlaps an
edit fails spuriously.

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
  A flow several personas run should filter with `assignee` or
  `reviewRequested: "@me"`.
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
  (`listMovedReposUseCase`, `repointRepoUseCase`); `unenroll` removes one
  (`unenrollRepoUseCase`).
- **Migration** (`src/migrate.ts`) runs before any command reads machine
  config: persona lists become maps, and an entry that lists no flows gets the
  ones that ran before plus `local.yaml`'s settings. It prints what it
  changed to stderr and leaves `local.yaml` for the person to delete.

## Setup and enrollment (#51)

`chernabog setup` (run by `install`) picks GitHub personas and AI accounts
(the machine module: `planSetupUseCase`, then `applySetupUseCase`, with
`src/interface/cli/machine/setup.command.ts` asking between them); `init` and
`enroll` run the enrollment wizard: `planEnrollmentUseCase`, the questions in
`src/interface/cli/enrollment/enroll.command.ts` (personas, then for each
persona its flows and then its accounts), then `applyEnrollmentUseCase`, which
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
  from `.chernabog/node_modules`. `checkFlowImports` refuses a repo whose
  imported package isn't a dependency, isn't the version `bun.lock` pins, or
  doesn't support the bundled SDK. The SDK's `FlowPackage` (which `flowLayer`
  provides) makes prompts and steps look in the repo, then the package.
- A recipe is written out from SDK **blocks**, trigger included, so its
  policy is in the repo's file. The SDK exports no whole workflows or
  review-loop triggers; add a block rather than hide a decision in one.
- This repo's own `.chernabog/flows/` are copied recipes. Keep them in step
  with `packages/recipes/` (`chernabog recipes diff`, from a sandbox, shows
  where they differ).
- **Activity names are journal keys**: a run in flight resumes by them, and a
  package version reaches every repo that imports it at once. Keep a recipe's
  step names when you change it, and never rename one in a block.
- `@chernabog/recipes`' `@chernabog/sdk` peer range must include the bundled
  SDK (a test checks). Keep it in step with `SUPPORTED_SDK`.
- The acceptance sandbox runs a local npm registry (`test/acceptance/fake-registry.ts`)
  that packs `packages/recipes/`, so bun installs for real with no network.
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
  values), `use-cases/` (one `<verbNoun>UseCase` per `<verb-noun>.use-case.ts`,
  its result schema in `.result.ts`), `infrastructure/{repositories,clients}/`
  (`-live.ts`, `-fake.ts`, `.mapper.ts`) and `<module>.layer.ts`. Shared
  primitives live in `src/kernel/`, inbound adapters in `src/interface/`.
  Filenames are dot-delimited stereotypes, kebab-case in front.
- **What reaches what.** The domain names effect, the kernel and its own
  module's domain. A use-case adds its ports; it never names infrastructure or
  interface, never prints, prompts or sets an exit code, and returns a typed
  result an adapter renders. Only repository adapters (and the legacy tier)
  name `yaml`; only the runs module's infrastructure and the engine name SQL.
- **Obligations.** A `.root-ops.ts` and a `.use-case.ts` each owe a sibling
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
  `ConfigTreeClient`. `trustRepoUseCase` is a security gate, so only the CLI
  offers it; never expose it to an agent-facing adapter such as MCP. The
  daemon, `doctor` and `status` read trust through `findTrustedTreeUseCase`.
  `ReloadRoot` (`reloaded.json`, by slug, behind `ReloadsRepository`) is the
  tree each repo last restarted the daemon on: the daemon restarts on a
  trusted tree only when `claimReloadUseCase` says it's the first time, so a
  trusted tree that fails to load restarts it once, not on every check.
- **Runs are the runs module's.** `RunRoot` (`om_runs` in `state.db`) keeps
  its lifecycle in `RunRootOps`: it starts running, takes steps while it runs
  and ends exactly once, and a persona has one run in flight per flow and item.
  `RunWaitRoot` (`om_waits`, with when it parked) parks a run on a signal;
  `RunStepRoot` (`om_steps`) logs each step a run enters, which
  `enterStepUseCase` writes beside its current step; `SkipRoot` (`om_skips`)
  logs why a tick started nothing. A run's `pullRequest` is the one it opened
  or adopted, which `flowLayer` links by wrapping the run's `GitHub`
  (`linkingPullRequests`); the live view threads an issue's runs with that
  pull request's by it. The engine, the daemon and `chernabog run`
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
  enrollment's `listPersonasInUseUseCase` in, since modules don't read each
  other.
- **A use-case doesn't talk.** The `no-talking` members rule reports a call to
  `log`, `warn`, `exit`, `pick` or `choose` in `use-cases/` and `domain/`.
- **Modules don't reach into each other.** An adapter composes them: the
  `trust` command lists its targets with enrollment's
  `listEnrolledReposUseCase`, then trusts each.
- **The platform** (`src/platform/`) holds the technical adapters everything
  shares: `exec.ts`, the host environment, `home.ts`, `github-api.ts` and
  `github-auth.ts`, `agent-accounts.ts`, `self.ts`, `version.ts`, the
  engine's `lock.ts`, `config-error.ts`, and a repo's `.chernabog/` as code:
  `flow-loader.ts`, `config-snapshot.ts`, `flow-deps.ts` and the generated
  `templates.ts` and `effect-modules.ts`. It names effect, node, the SDK, the
  kernel and itself, nothing else.
- **The composition roots are adapters too**: the CLI's
  `src/interface/cli/main.ts`, the daemon's `src/interface/daemon/daemon.server.ts`
  and the live view in `src/interface/tui/`. Each has its own allowlist in
  `architecture.yaml`, which names, file by file, the legacy runtime it still
  drives; moving a file into a module takes it off those lists.
- **The runtime** a run's flow executes in is the runs module's
  `infrastructure/runtime/`: the workflow engine and step runner, the SDK's
  services over GitHub, git, worktrees and usage, and the agents and
  launchers. They adapt the published SDK's ports, report a run's steps and
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
- **Every rule carries a probe**, and the plugin refuses to load a rule that
  can't fire. To change the policy, edit `architecture.yaml` (the
  `yaml-language-server` schema completes and checks it), plant the violation
  you mean to catch, and see it reported. `bun run architecture:explain <file>`
  shows every rule that governs a file.

## Errors (#75)

Errors split by who acts on them (`packages/sdk/src/errors.ts`).

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

## Versions (#123)

One binary runs every enrolled repo, so compatibility is the binary's call.

- **The SDK pin is the contract.** A repo's `.chernabog/package.json`
  `@chernabog/sdk` pin is the SDK its flows are written against; the binary
  runs `SUPPORTED_SDK` (`src/kernel/sdk-support.value-object.ts`): up to the
  minor of `BUNDLED_SDK_VERSION`, which release-please moves with the SDK's
  version, from `OLDEST_SUPPORTED_SDK`, which a person moves up when a minor
  breaks flows written against the one before.
  `checkCompatibility` (`src/platform/flow-deps.ts`) refuses a repo outside it,
  without a pin, with `engines.chernabog`, or whose flows import what the
  bundled SDK lacks, as `IncompatibleConfig`; the daemon shows it as
  `incompatible`. `upgradeRepoUseCase` (`chernabog recipes upgrade`) is
  the way forward, and the only thing that moves an existing manifest's pins.
- **Local state is stamped, backed up and refused.** Machine config's
  `chernabog:` key and `state.db`'s `om_meta` hold the version that last
  migrated them (`src/migrate.ts`, `state-stamp.ts` beside the engine). Any
  older stamp is copied to `backups/` first (`src/platform/backups.ts`); a
  newer one is refused with restore instructions. There are no down
  migrations.
- **Runs record their SDK** (`om_runs.sdk_version`). `flowLayer` never runs a
  flow for a run whose SDK this binary doesn't support, and the daemon ends
  such runs at startup through `cancelRunUseCase` with `needsHuman`. When its
  executable changes, the daemon drains: no ticks, `/run` refused, and a
  restart once no run is executing (parked runs don't count).

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

- `reviewers:` in the team's config is the pool. `Implement.handOff` calls
  `PullRequest.requestReview`, which picks one at random, never the author,
  inside an activity so a replay asks the same login; no pool means
  `auto:needs-review` for a person.
- `review` runs as a persona whose review is requested and who hasn't
  reviewed; `re-review` as one asked again, resuming
  its session with `Review.recheck` from the review marker (which records
  reviewer, sessionId and adapter). `limits.reviewRounds` (default 1) caps
  re-reviews.
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
  waits (#76). The pool's rules are the kernel's
  (`src/kernel/reviewer-pool.value-object.ts`), since enrollment, runs and
  doctor all read them. `doctor` warns (`!`, not a failure) per persona that
  authors (runs `implement`, `human-initiated`, or a flow whose code mentions
  `requestReview`/`handOff`, read by `authoringFlows` in
  `src/platform/flow-loader.ts`) when the pool less that author has no login
  under `github:`; `applyEnrollmentUseCase` returns the same as `unserved`,
  which `enroll` prints as a note; and `planTickUseCase`, for the `review`
  flow, reads `FlowsClient.reviewRequests` (one `openPullRequests` call,
  before the trigger, which it leaves alone) and returns
  `#n waits on <login> (not on this machine)` as `TickPlan.unserved`, which
  the daemon adds to the schedule's `elsewhere`.
- Gone: the `ship` composite flow, `Review.labelVerdict`/`reviewRound`,
  review's wait-for-push loop, and the `fix` flow (`Review.fixTrigger`,
  `fixWorkflow`, `FixItem`, the `fix` prompt), and the whole workflows and
  triggers `Implement.workflow`/`trigger`, `Review.workflow`/`trigger`,
  `reReviewWorkflow`/`reReviewTrigger` and `addressWorkflow`/`addressTrigger`
  (#67: the recipes write them out). `auto:approved`, `auto:stale`
  and `auto:changes-requested` stay in the label set but no default flow sets
  them.

### Hybrid path (#55)

- No hybrid flow is scaffolded: `init` writes the same four defaults. The
  SDK ships only blocks (`Hybrid.trigger`/`itemFor`/`claim`/`workWithPerson`/
  `personSession`/`openPullRequest`/`handOff`; no `Hybrid.workflow`), and a
  repo writes its own `human-initiated` flow from them, as this repo's
  `.chernabog/flows/human-initiated.ts` does (`ownWork: true`, no gate). Its
  trigger finds nothing on a schedule; `chernabog start <issue>`
  (`src/interface/cli/runs/start.main.ts`, `START_FLOW`) asks the daemon to run `human-initiated` on
  `issue-<n>` (failing with a link to the docs' `#the-hybrid-path` when the
  repo has no such flow). The optional `Flow.item(key)` finds an item the
  trigger doesn't report (`FlowsClient.find`, for the daemon
  and `run --item`). It then attaches to the session (`liveAttach`).
- `Hybrid.claim` takes over an earlier start's claim (`ClaimMarker.withPerson`)
  but skips a branch an unattended run claimed. One Claude session per
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
