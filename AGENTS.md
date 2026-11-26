# Chernabog

A daemon that runs agent sessions (Claude, Codex, …) on a repo's issues and pull
requests, on a schedule, as one or more GitHub personas. Bun, TypeScript, Effect v4.

## Before you finish

`bun run format:check`, `bun run check`, `bun run lint` and
`bun run lint:architecture`, the fast checks, must all pass.

`bun run test` must pass too.

The pre-commit hook (`.husky/pre-commit`, installed by `bun install`) runs the
fast checks in that order through `bun run precommit` and refuses the commit at
the first failure, in the main checkout and in a linked worktree alike. It only
checks: `bun run format` applies Prettier. It leaves out the tests, which take
minutes: an agent's commit lands before it answers, and a commit of failing
tests on their own (test-first's red step) passes. The tests run in chernabog's
local gate before every push, and in CI. `HUSKY=0 git commit …` skips the hook
for a work-in-progress commit you will fix before pushing; never `--no-verify`
one that you push. CI's build and its tests of the binary stay in CI.

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

- **Chernabog runs Claude with `-p` / `--print` only where a person has chosen
  no launcher.** Every agent session it starts is interactive, through a
  launcher (orca, tmux, or the person's own). This is a billing constraint, not
  a style choice: `-p` sessions are billed more heavily, even on a
  subscription. Exactly two uses are allowed, and only for a repo whose
  launcher is `headless` (the default when machine config names none):
  - the `headless` launcher itself (`src/modules/runs/infrastructure/runtime/agents/claude.ts`),
    which a person picks by not setting up an interactive one; `doctor` says
    so (`runs use claude -p (launcher headless)`);
  - the usage gate's token refresh
    (`src/modules/runs/infrastructure/runtime/usage-gate.ts`), one
    `Reply with OK.` prompt on haiku, which makes claude refresh the stored
    token. Under a launcher, it runs that prompt interactively instead.

  Nothing else uses `-p`: not a flow, a step, a recipe or CI. Treat
  `--output-format stream-json` and `--json-schema`, which need print mode,
  the same way.

- **Never kill processes by name** (`pkill claude` and the like). Target the PID
  or launcher handle you captured.
- **Multi-PR work is a `gh stack`.** Read `gh stack --help` (or your agent's
  gh-stack skill, if it has one) before any stack command, and always use the
  non-interactive forms (`gh stack view --json`, `gh stack submit --auto`).

## Investigating a failure

Look before you guess. Everything below is under the chernabog home,
`~/.config/chernabog` (`CHERNABOG_HOME` moves it; a sandbox's is its `home/`).

- **`daemon.log`**: what the daemon says, a timestamped line each: runs started
  and finished, skipped ticks, restarts, retention sweeps. Today's (UTC);
  earlier days' are `daemon.<YYYY-MM-DD>.log`, deleted after 30 days.
- **`daemon.out.log`**: the daemon's stdout and stderr as the service manager
  catches them, which is mostly a crash. Emptied past 10 MB.
- **`runs/<run>.log`**: one run's steps and agent output, a line an entry,
  `<ISO>\t<step>\t<text>`: the innermost activity the writing fiber was in
  (`CurrentActivity`), empty outside any. A run of a flow compiled from a
  document also tags a line with the plan node it was written in, its round
  and lane (`CurrentNode`), after the step:
  `<ISO>\t<step>\t@{"id":"ci","round":2,"lane":"task-10"}\t<text>`. A log
  from before tags is `<ISO> <text>`. `chernabog logs <run>` prints it without the tags
  (`src/kernel/run-log-line.value-object.ts`). Kept 30 days from when its run finished
  (a run still running keeps its log; a log state.db has no run for, 30 days
  from its last write), pruned by the daemon's daily sweep.
- **`journals/<run>.db`**: one run's workflow journal, the engine's tables
  for that run alone (ADR 23, decision 3; `journals.ts` in the runs
  module's runtime). Created when the run executes and deleted when it ends
  (`discard-run-journal`, on `RunFinished`), cancel included; one left by a
  crash is swept by `SweepJournalsCommand`. `state.db` holds no engine
  tables for runs; a migration drops those from before (`state-stamp.ts`).
- **`telemetry/<day>/<process>-<pid>.jsonl`**: every span and Effect log line
  of one process (`daemon` or `cli`), one JSON object a line, in the folder of
  the UTC day it was written (`FileTelemetry`, `src/platform/telemetry.ts`).
  The daemon sweeps it when it starts and every 24 hours
  (`TELEMETRY_RETENTION`, `src/platform/retention.ts`): day folders older than
  30 days go, then the oldest while the rest hold more than 500 MB, never
  today's. Today's is held to that 500 MB as it's written: past it, the
  daemon or a CLI call writes no more telemetry until the next UTC day, and
  says so once on stderr (the daemon in `daemon.log` too). A spoke is held
  to its own bound instead (`--telemetry-limit`, ADR 23, decision 4).

A **span** line is `type: "span"`, `traceId`, `spanId`, `parentSpanId` (absent
on a root), `name`, `startTime`, `endTime` (ISO), `durationMs`, `status`
(`ok`, `error`, or `unfinished` for one still open when the process stopped),
`attributes`, and on an error `error`, the pretty cause. Commands, queries and
events are `command.<Tag>`, `query.<Tag>` and `event.<Tag>`; the ones about a
run carry `run.id`, and `run.repo` / `run.flow` where they have them
(`src/modules/runs/runs.event-span-attributes.ts`). A **log** line is
`type: "log"`, `time`, `level`, `message`, `annotations`, `cause` when there is
one, and the `traceId` / `spanId` of the span it was logged in. Chernabog's
own code narrates to `daemon.log` and the run logs rather than `Effect.log`,
so log lines are rare.

From the home, with `RUN` a full run id (`chernabog status` shows its first 8
characters; `ls runs/ | grep ^<prefix>` finds the full one):

```sh
# Every span and log line of one run: the traces any span naming it is in,
# then every record of those traces, across the daemon's and the CLI's files.
jq -n -c --arg run "$RUN" '
  [inputs] as $all
  | [$all[] | select(.attributes["run.id"] == $run) | .traceId] as $traces
  | $all[] | select(.traceId | IN($traces[]))' telemetry/*/*.jsonl

# Every failed span on one day, with its cause. Some are expected, such as a
# 404 GET for a lease ref that isn't there yet.
jq -c 'select(.type == "span" and .status == "error")
  | {startTime, name, traceId, error}' telemetry/2026-10-31/*.jsonl

# One trace as a tree, by parentSpanId: each span's name, status and time.
jq -n -r --arg trace "$TRACE" '
  [inputs | select(.type == "span" and .traceId == $trace)] as $spans
  | ($spans | map(.spanId)) as $ids
  | def tree($span; $depth):
      ("  " * $depth) + "\($span.name) \($span.status) \($span.durationMs)ms",
      ($spans | map(select(.parentSpanId == $span.spanId)) | sort_by(.startTime)[]
        | tree(.; $depth + 1));
    $spans | map(select(.parentSpanId == null or (.parentSpanId | IN($ids[]) | not)))
    | sort_by(.startTime)[] | tree(.; 0)' telemetry/*/*.jsonl
```

A run's first trace is the one its `event.RunStarted` span is in:
`jq -r --arg run "$RUN" 'select(.name == "event.RunStarted" and .attributes["run.id"] == $run) | .traceId' telemetry/*/*.jsonl`.

## The dashboard's listener (#323)

The daemon's routes answer on its unix socket. `chernabog ui` asks it
(`POST /dashboard/start`, socket-only) to open a TCP listener on 127.0.0.1
for a browser (`src/interface/daemon/dashboard.server.ts`). That listener
passes the page and `/api/<route>` on to the socket's `/<route>`, so a route
is written once, in the socket's router, and answers on both. A route a
browser must never reach is listed in `SOCKET_ONLY_ROUTES` there; the
`/dashboard` routes are. Every TCP request is checked for its `Host`, a
change for its `Origin` and a JSON `Content-Type`, and `/api/` for the cookie
the token in `dashboard.token` sets. `dashboard.json` records whether it's to
run and its port, so a restarted daemon opens it again: runtime state, not
machine config.

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
  input with `ResolveRunIdQuery` (unique prefix).
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
(the machine module: `PlanSetupQuery`, then `ApplySetupCommand`, with
`src/modules/machine/interface/cli/setup.endpoint.ts` asking between them); `init` and
`enroll` run the enrollment wizard: `PlanEnrollmentQuery`, the questions in
`src/modules/enrollment/interface/cli/enroll.endpoint.ts` (personas, then for each
persona its flows and then its accounts), then `ApplyEnrollmentCommand`, which
resolves what wasn't answered and writes the entry once. The machine's
personas and accounts come in from the machine module's
`ReadMachineSetupQuery`.

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
  what the binary bundles (the scaffold, the pins) through `BundleClient`, and
  flow documents through `FlowCompilerClient`, with the SDK the repo pins.
  `init` dispatches `ScaffoldRepoCommand` and `AddRecipePackageCommand`;
  `recipes` asks `ListRecipesQuery` and `DiffRecipesQuery`, and dispatches
  `AddRecipesCommand`, `ImportRecipesCommand`, `EjectRecipeCommand`,
  `UpdateRecipesCommand`, `UpgradeRepoCommand` and
  `CompileFlowDocumentsCommand`.
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
  (`x.root.ts`, a `Schema.Class` exporting `XRoot`; `x.root-ops.ts`, the
  `XRootOps` bag of pure functions returning `Result`; `.entity.ts`, an
  `XEntity` with an identity inside the aggregate; `.aggregate.ts`, a
  constituent aggregate, and its domain-private `.aggregate-ops.ts` bag;
  `.id.ts` (`XId`), `.errors.ts`, `.value-object.ts`, `.events.ts`, the
  domain events its commands dispatch, `.specification.ts`, the predicates it
  is read by, and `.repository.ts`, its repository port),
  `domain/domain-services/` (`.domain-service.ts`, a pure free-function bag
  for domain logic no single aggregate owns, such as `Routing`),
  `domain/ports/clients/` (a port is a `Context.Service` and its shape, no
  values), `commands/` and `queries/` (per message, a `<verb-noun>.command.ts`
  or `.query.ts` declaring it and its result schema, and a
  `<verb-noun>.handler.ts` exporting one `<verbNoun>Handler`, its value
  exports camelCase),
  `domain/ports/acl/` (what it asks another module),
  `infrastructure/{repositories,clients,acl}/`
  (`-live.ts`, `-fake.ts`, `.mapper.ts`), `storage/` (`<name>.schema.ts`, the
  format of a file or table its repositories write and its queries read),
  `<module>.module.ts`,
  `event-handlers/` (per reaction to an event, a `<verb-noun>.handler.ts`
  exporting one `<verbNoun>Handler`, and `triggers/<publisher>.triggers.ts`
  subscribing them, ADR 13),
  `<module>.platform.ts` (what it publishes to the adapters),
  `<module>.contracts.ts` (the value objects and events the daemon's protocol
  carries, re-exported from its domain alone, so the dashboard can bundle
  them for a browser),
  `<module>.command-handlers.ts` / `<module>.query-handlers.ts`, which bind
  the handlers to their messages and declare the module's dispatchers
  (`TrustCommands`, `TrustQueries`), and
  `<module>.event-span-attributes.ts`, what the dispatchers' and event bus's
  spans say (the runs' name the run, its repo and its flow). Which of the
  hexagon's stereotypes are here, and which aren't yet, is
  `docs/adr/0009-the-hexagons-remaining-stereotypes.md`. A module wires itself in its
  `<module>.module.ts` (`docs/adr/0012-modules-wire-themselves.md`):
  `<Module>Module.layer` is its dispatchers over the live adapters they
  need, and `routes` the groups they answer, for the buses.
  `src/interface/application-modules.ts` is the one list of modules, and
  `src/interface/application-runtime.ts` the one place a runtime is
  assembled (`docs/adr/0015-composition-roots.md`): `ApplicationLive` (every
  module's `layer`, the merged `CommandBus` and `QueryBus`, the event bus),
  which the CLI's `AppLive` adds its own services to, and `engineRuntime`,
  which a root that runs the engine (the daemon, `run`, `rehearse`, `cancel`)
  builds from its flows, its registry (`RunsModule.runtime`) and its engine
  (`EngineLive`, `EngineAt`). A service that differs between roots is the
  root's to provide. Shared
  primitives live in `src/kernel/`, inbound adapters in `src/interface/`.
  Filenames are dot-delimited stereotypes, kebab-case in front.
- **The browser tier** (`docs/adr/0016-the-browser-tier.md`).
  `packages/dashboard` is the React page the daemon serves at `/` on its
  socket; Bun bundles it from `index.html` and `bun build --compile` embeds
  it. It has its own tsconfig (DOM, JSX), which `bun run check` runs too, and
  names effect, React, its own files and the daemon's protocol
  (`#daemon/protocol`), nothing else of `src/`.
- **What reaches what.** The domain names effect, the kernel and its own
  module's domain. A handler adds its ports; it never names infrastructure or
  interface, never prints, prompts or sets an exit code, and returns a typed
  result an adapter renders: a value object or event in the domain, which the
  adapters name through the module's `*.platform.ts`, and the daemon's
  protocol through its `*.contracts.ts`. Only repository adapters, queries (and the legacy tier)
  name `yaml`, and the recipes module's `flow-compiler.client-live.ts`, which
  reports a flow document's problems by where they are in its YAML; only the runs module's infrastructure, its queries and the
  engine name SQL.
- **Queries read their storage directly** (ADR 11). A query reads its file
  with `FileSystem` (or `state.db` with SQL, in runs), decodes it with the
  Schema in its module's `storage/`, and answers with a read model declared in
  its `*.query.ts`. From the domain it names only ids and client ports; never
  a root, root-ops, repository, specification, value object, error or event.
  A command never answers with a query's view: it returns less, and the
  adapter asks the query.
- **Obligations.** A `.root-ops.ts`, an `.aggregate-ops.ts`, a
  `.domain-service.ts`, a `.specification.ts` and a `.handler.ts` each owe a
  sibling `.test.ts`; a repository or client port owes its `-live.ts`,
  `-fake.ts` and `-live.test.ts`. The lint names what is missing.
- **Repositories speak the persistence vocabulary** (ADR 8). A port declares
  only `findOne`/`findMany`, each taking a `Specification` from the kernel
  kit (`src/kernel/specification.ts`), and the writes
  `insertOne`/`updateOne`/`deleteOne`/`upsertOne` and their `Many` forms. A
  lookup or variant is a spec in the aggregate's `<aggregate>.specification.ts`
  (`RunSpecifications.withId(id)`), composed at the call site with `Spec.and`,
  `Spec.or` and `Spec.not`. The SQLite adapters compile it to a WHERE fragment
  (`criteriaToWhere`, in the runs module's `infrastructure/repositories/`);
  the file-backed ones and every fake filter with the spec itself. A store kept
  where the aggregate says (a scenario at its path, a checkout's flow imports)
  reads that place from the spec with `pinnedValue`.
- **Enrollment is the first module.** `EnrolledReposRepository` loads and saves
  an `EnrolledRepoRoot`: its machine-config entry (edited in place, comments
  kept, and written only when the entry changed) and whether it's paused
  (`paused.json`, by slug, so clones of one repo pause together). `pause` and
  `resume` are use-cases the CLI (`src/modules/enrollment/interface/cli/`), the TUI
  and the daemon's gate all go through. Enrolling, pausing, resuming and
  unenrolling a repo dispatch `RepoEnrolled`, `RepoPaused`, `RepoResumed` and
  `RepoUnenrolled` (`enrolled-repo.events.ts`) on the `EventBus` that
  the shared runtime provides; a settings change dispatches nothing.
- **Trust is its own module**, apart from the config a person edits:
  `TrustRecordRoot` (the tree of `.chernabog/` a person approved, in
  `trust.json` by slug) behind `TrustRecordsRepository`, and git behind
  `ConfigTreeClient`. It is the CQRS worked example (ADR 6): adapters ask
  `TrustQueries` and `TrustCommands`. `TrustRepoCommand` is a security gate,
  so only the CLI dispatches it; never expose it to an agent-facing adapter
  such as MCP. It dispatches `RepoTrusted` (`trust-record.events.ts`) once
  the record is saved. The daemon and `doctor` read trust through
  `FindTrustedTreeQuery`, `status` through `CheckTrustQuery`.
  `ReloadRoot` (`reloaded.json`, by slug, behind `ReloadsRepository`) is the
  tree each repo last restarted the daemon on: the daemon restarts on a
  trusted tree only when `ClaimReloadCommand` says it's the first time, so a
  trusted tree that fails to load restarts it once, not on every check.
- **Runs are the runs module's.** `RunRoot` (`om_runs` in `state.db`) keeps
  its lifecycle in `RunRootOps`: it starts running, takes steps while it runs
  and ends exactly once, and a persona has one run in flight per flow and item.
  `RunWaitRoot` (`om_waits`, with when it parked) parks a run on a signal;
  `RunStepEntity` (`om_steps`, in `run/`) logs each step a run enters, which
  `EnterStepCommand` writes beside its current step, and `FinishStepCommand`
  ends with its outcome (core's `activity` reports it through
  `RunLog.stepFinished`; never for an interrupted or replayed step);
  `RunLaneEntity` (`om_lanes`) is what each lane of a run waited on, as its
  flow declared with core's `Lanes.declare` (`DeclareLaneCommand`, which only
  adds); `SkipRoot` (`om_skips`)
  logs why a tick started nothing. A run's `subjects` (`om_run_subjects`)
  are the work items it named with core's `Subjects.name`, such as the pull
  request an SDK block opened or adopted; the engine records them through
  `NameSubjectCommand` and knows nothing of what they mean. The live view
  threads runs that share a work item, as their own or as a subject, and a
  flow's `stillValid` gets them as `Run`'s `subjects`. The engine, the daemon and `chernabog run`
  record and read them only through the module's queries, commands and
  use-cases (`StartRunCommand`, `EnterStepCommand`, `FinishRunCommand`, …): the
  ones over state.db alone are `RunsQueries` and `RunsCommands`, and the ones
  over the flows a process loaded `RunFlowsQueries` and `RunFlowsCommands`,
  which the daemon, `run` and `rehearse` build over their runtime; a run's
  `RunView` is what crosses the socket. `RunsRepository.upsertOne` never rewrites a
  run that ended with another ending, so a stale copy can't revive it.
  `RunId`, `shortRunId` and `runLabel` are in `src/kernel/run-id.id.ts`.
  The flow rules the daemon decides by are the runs module's domain too, as
  value objects with their tests: `schedule/` (which cron expression a
  persona's flow ticks on, next ticks, active and quiet hours, and
  `decideTick`/`freeSlots` in `tick.value-object.ts`), the `Routing` domain
  service (`domain-services/routing.domain-service.ts`: whose work items a
  persona's flow starts here) and `usage/` (`decideLaunch`, the usage
  gate's decision).
- **A tick is a plan, applied by the daemon.** A use-case never calls another
  use-case (`architecture.yaml` forbids it); what several do together, the
  composition root that calls them composes. `PlanTickCommand` is one tick of
  a persona's flow up to what it would do: the machine's gates, the trigger,
  routing and the concurrency limits, recording a skip when it would start
  nothing. It returns a `TickPlan`: the work to start runs for. The daemon
  then, item by item, asks the flow's own gate (`GateFlowCommand`, before
  every start, since a started run may close it), records the run
  (`StartSpokeRunCommand`) and starts its spoke. No signal is delivered to a
  run in flight: a park ends its run. Flows run through `FlowsClient`
  (trigger, item lookup, gate) and workflows through `WorkflowsClient`
  (execute, poll, interrupt, journals, note); the daemon and `chernabog run` build
  both from the flows they loaded (`RunsModule.runtime(registry)`, the registry's
  type in `infrastructure/runtime/flow-registry.ts`) and pass in what other modules know, such as whether the
  repo is paused.
- **A start survives a crash.** A run is recorded with its execution
  attached, keyed by the run, in one unit of work (`StartSpokeRunCommand`),
  before anything executes it, so no run is ever left without an execution.
  A process killed after that leaves a running run, which the next hub ends
  as interrupted (or the next foreground `run` of its flow, once no live
  process owns it), and its phase repeats in a new run. Nothing resumes a run
  from its journal.
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
  Run logs are behind `RunLogsClient`: `ResolveRunIdQuery` names a run by
  a prefix of its id, `ReadRunLogQuery` reads its log, and
  `FollowRunLogQuery` reads what it gained from an offset. Following a log is
  the CLI's (`followLog` in `src/modules/runs/interface/cli/run-log.output.ts`): a
  `Stream` of those reads, ended by an effect it passes, since only the
  caller knows who to ask whether the run finished (the CLI asks the daemon).
- **The daemon is an adapter too.** `src/interface/daemon/` holds its
  socket protocol (`daemon.protocol.ts`, made of the modules' results) and
  the client the CLI and TUI ask it with (`daemon.client.ts`), beside its
  server, which keeps the schedules and the socket and registers the routes a
  module serves itself (`runsRoutes`). The CLI's
  `status`, `logs` and the rest print a use-case's result, and with `--json`
  print it through its schema instead (`printJson` in
  `src/interface/cli/cli.output.ts`).
- **State-changing commands go through the daemon first**
  (`docs/adr/0017-state-changing-commands-go-through-the-daemon.md`), so
  their events reach its bus. `POST /commands/:tag`
  (`daemon-commands.server.ts`) dispatches an allowlisted command
  (`daemon-commands.client.ts`) on the daemon's `CommandBus`, coded with
  the command's own schemas; the CLI and TUI call it through
  `DaemonEnrollmentCommands` / `DaemonTrustCommands` and `throughDaemon`,
  which dispatches here only on `DaemonUnavailable`, never after a refusal.
  A command the daemon runs runs as the daemon: one that depends on who ran
  it carries that in its payload, as `CancelRequest.by` does.
- **`GET /events` is how clients hear of changes** (#324): a
  `text/event-stream` of one `snapshot` (what `/status` answers), then each
  `DaemonEvent` (`daemon.protocol.ts`) as `event: <_tag>`, `id: <eventId>`,
  and a `: ping` every 15 seconds (`events-stream.event-adapter.ts`). Each
  client subscribes to the bus before its snapshot; clients connecting within
  a second share one computation, and one that joins a computation begun
  before it subscribed is sent what it missed. The daemon's own events
  (`DaemonReloading`, `TickRan`, `StatusChanged`) are `broadcast` to streams
  only. `StatusChanged` covers what the bus can't hear: the daemon watches the
  home (`watchStateChanges`, `src/platform/state-changes.ts`) and says it,
  once a second at most, when another process changed machine config,
  `paused.json` or `trust.json` (a file `updateFile` wrote in this process
  is its own) or committed to `state.db` (`ReadStateVersionQuery`, SQLite's
  `data_version`). It also looks every 5 seconds without being told, because
  file events can stop coming on macOS under load.
- **The machine module** owns this machine's setup: `MachineSetupRoot`
  (`github:` personas and `accounts:`, edited in place in machine config),
  gh's logins, the account directories in the home, and the daemon as a
  launchd or systemd service (`ServiceManagerClient`). `ApplySetupCommand`
  refuses to drop a persona an enrolled repo runs as; the `setup` endpoint
  passes enrollment's `ListPersonasInUseQuery` in, through the grant
  `machine.imports.ts` takes.
- **Every command declares its unit of work** (ADR 10): its handler pipes
  `withUnitOfWork` at the end of its `Effect.fn`, and demotes
  `PersistenceUnavailable` to a defect beside it. The runs' commands open a
  `state.db` transaction (`RunsUnitOfWorkLive`, provided by `StateAt`);
  the file stores' a scope that opens nothing (`FileStoresUnitOfWork`, in
  `AppLive`), and each dispatcher pins its own (`ownUnitOfWork`). A
  transaction holds `state.db`'s one connection, which the runs' steps
  wait on: never call GitHub, git, a launcher or the engine inside one. A
  command that calls out declares the boundary around its `state.db` reads
  and writes only. Events are dispatched inside the unit of work; a
  dispatch outside one is a defect. Handler tests get `PassThroughUnitOfWork`
  with `RecordedEvents` (`test/events.ts`).
- **Side effects outside a command's boundary are event handlers** (ADR 13).
  A module's `event-handlers/<verb-noun>.handler.ts` reacts to one event,
  with a command's dependency shape and a required test that hands it the
  event and shows a repeat does nothing twice; `event-handlers/triggers/<publisher>.triggers.ts`
  subscribes them, joining `<Module>Module.events`. Subscribe after commit
  with a stable `{ name }`; `subscribe` is only for a reaction that must roll
  its publisher back. The runs' reactions run after commit outside any
  transaction (`UnitOfWorkReactingAfterCommit`), in memory, so a crash
  loses them: keep a sweep for what one leaves undone, as
  `ReleaseMarkersCommand` is behind `release-run-markers` on `RunFinished`.
  The daemon's reactions are inbound event adapters
  (`src/interface/daemon/*.event-adapter.ts`), such as the run endings it
  logs.
- **A handler doesn't talk.** The `no-talking` members rule reports a call to
  `log`, `warn`, `exit`, `pick` or `choose` in `commands/`, `queries/` and
  `domain/`.
- **Modules ask each other only through ACL ports**
  (`docs/adr/0013-modules-import-and-export.md`). An owner grants queries in
  `<module>.exports.ts` (`recipesAccessQueries =
Query.subsetOf(recipesQueryGroup, "ReadTeamConfigQuery")`, named
  `<module>Access<Queries|Commands|DomainEvents|Errors>`, never a bare
  re-export, and only with a consumer). The asker names that grant in its
  `<module>.imports.ts`, declares a port in its own words in
  `domain/ports/acl/<question>.acl.ts` (owing `-live.ts`, `-fake.ts` and
  `-live.test.ts` in `infrastructure/acl/`), and its live adapter dispatches
  the grant and translates the answer. Its handlers ask the port; they never
  name the other module or its messages. The asker's `<module>.module.ts`
  provides the owner's `<module>.module.ts` beneath its ACL adapter (ADR 12),
  as `enrollment.module.ts` does with recipes. Owners: enrollment the enrolled repos and their
  per-persona choices, machine the personas and accounts, recipes the team's
  `.chernabog/config.yaml` (`ReadTeamConfigQuery`). An inbound adapter in
  a module's `interface/` may also dispatch a grant its `<module>.imports.ts`
  takes, to compose a peer's answer with its own module's
  (`docs/adr/0014-inbound-adapters-live-in-their-module.md`): `trust` lists
  its targets with enrollment's `ListEnrolledReposQuery`, then trusts each.
  `Query.dispatcher` needs a scope, so such a dispatch is `Effect.scoped`.
- **A module's inbound adapters live in the module**
  (`docs/adr/0014-inbound-adapters-live-in-their-module.md`):
  `src/modules/<module>/interface/cli/<command>.endpoint.ts` per CLI command
  and `interface/daemon/<route>.endpoint.ts` per daemon route it alone serves,
  each registered in a `<module>.endpoint-groups.ts` that `main.ts` (or the
  daemon's server) names directly. `src/interface/cli/` keeps only the
  composition roots (`main.ts`, and the `*.main.ts` that compose the engine,
  the runs' runtime or several modules) and the shared arguments, output and
  `asker.prompt.ts`; `status` is the TUI's twin, in `src/interface/tui/`.
- **The platform** (`src/platform/`) holds the technical adapters everything
  shares: `exec.ts`, the host environment, `home.ts`, `github-api.ts` and
  `github-auth.ts`, `agent-accounts.ts`, `self.ts`, `version.ts`, the
  engine's `lock.ts`, `config-error.ts`, and a repo's `.chernabog/` as code:
  `flow-loader.ts`, `config-snapshot.ts`, `flow-deps.ts` and the generated
  `templates.ts` and `effect-modules.ts`. It names effect, node, core, the
  kernel and itself, nothing else.
- **The composition roots are adapters too**: the CLI's
  `src/interface/cli/main.ts`, the daemon's `src/interface/daemon/daemon.server.ts`,
  the `*.main.ts` commands that build an engine, and the tests' harnesses.
  Each has its own allowlist in `architecture.yaml`, which names, file by
  file, the legacy files it still reads.
- **Buses and Lives at the roots** (ADR 15). Only `application-runtime.ts`
  (and tests) calls `makeEventBus`, `makeCommandBus`, `makeQueryBus` or
  `mergeDispatchTables` (the `no-bus-factories` rule). A `*-live.ts` adapter
  is named only by its module's `<module>.module.ts` and tests
  (`lives-at-roots`); a helper adapters share goes in a file of its own. Each
  bus is built with `declaredIn`, so a group nothing answers fails at
  startup. A new message's schemas must cross JSON: each module's
  `<module>.serializable.test.ts` checks its groups and events.
- **A module publishes one surface** (`docs/adr/0007-module-gateways.md`):
  `<module>.platform.ts` re-exports, and only re-exports, what the inbound
  adapters name: its dispatchers, its `<Module>Module`, and the results,
  value objects and events its messages answer with. Nothing
  outside `src/modules/` but tests (and the legacy `repo-config.ts`) reaches
  past it, and only `src/interface/` names it. To use something new from a
  module, re-export it there. The runs module's runtime the roots still
  compose is published from `runs.platform.ts` for now, in a section marked
  interim. A module names another's vocabulary only through its
  `*.exports.ts`, and only from its own `*.imports.ts`; its `*.module.ts`
  provides another module's `layer` by that module's `*.module.ts`, with
  `Layer.provide` (never `provideMerge`, which re-exports it). A new module
  joins `src/interface/application-modules.ts` and is wired in every root.
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
  under way. `repo-config` counts the files under `src/` that still import
  `src/repo-config.ts`; each moves onto its owner's repository or an ACL port
  (ADR 13), and the file is deleted when none is left. `read-models` (ADR 11,
  #283) counts the queries still reaching their module's domain. `cqrs`, which
  moved every use-case to a command or query and had the commands dispatch
  their domain events, is retired (#273). A campaign's ledger in
  `.architecture-campaigns/` lists what is
  left and may only shrink. A change that moves one runs
  `bun run architecture:clear` and commits the ledger with it;
  `bun run architecture:campaigns` shows what's left. Always clear through
  the script: a bare `architecture objectives clear` walks `packages/`, finds
  no module, and closes every holdout. Never `objectives concede` to make the
  gate pass. A phase no objective can see is `attested: true`, and each
  sector leaves it by `architecture campaigns attest`, with its reason. To
  retire a finished campaign, delete its entry and its ledger.
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
  `PushRejected`, `NothingCommitted`, `CiTimedOut`, `PhaseMoved`) are typed on the service
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
  `PlanTickCommand` records as the tick's skip reason as it stands, fix
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
  run, name and arguments. `ReleaseMarkersCommand` releases what ended runs
  hold, newest first, through `FlowsClient.releaseMarker` (the loaded flow's
  definition, as the run's persona); keepOn endings are kept, a failure backs
  off (`RunMarkerRootOps.backoff`), and a missing definition is unreleasable.
  The daemon runs it every few seconds, `chernabog run` once its run ends, and
  `status` shows `ListUnreleasedMarkersQuery`.
- **An interrupted run's item is offered again** (#665). A claim that takes
  the label that queued an issue off it (`Implement.claim`, `Hybrid.claim`,
  through `Implement.takeQueueLabel`) first holds core's `Markers.requeue`
  for it, only for a label the issue carried. `RunMarkerRootOps.keptOn`
  releases that marker on an `interrupted` ending alone, which puts the label
  back, so the trigger offers the item and the phase repeats in a new run;
  every other ending keeps it, and the label stays off.
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
  `ScaffoldRepoCommand`, which `init` and `recipes add`, `update` and
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
  `rehearsals/<id>/`, and only seeded work items (`ChooseSeededWorkQuery`).
- **An enrolled repo is refused** unless the scenario says `enrolled: true` or
  the person passes `--on-enrolled`; then it is paused on this machine
  meanwhile, and cloned from its own origin.

## Token usage and compute time (#405)

What each agent call spent, in raw tokens per model, and how long a run
computed for. docs/adr/0018-token-usage-and-compute-time.md has the why.

- **`TokenUsage` is not `Usage`.** `Usage` is the quota gate (the core port,
  `domain/usage/`, `decideLaunch`). Token usage lives in `domain/token-usage/`
  and `domain/token-usage-cursor/`; never give it a name the gate uses.
- **Where it's stored**, in state.db: `om_agent_usage`, one row per agent call
  and model (run, step, adapter, session, model, input, output, cache read,
  cache write, `reported`), and `om_usage_cursors`, how far each adapter has
  read each session. `RecordTokenUsageCommand` writes both in one unit of
  work. Totals and breakdowns are aggregated by `ReadRunUsageQuery`
  (`GET /runs/:id/usage`), never stored. Compute time is the union of the
  run's steps in `om_steps` (`domain-services/compute-time.domain-service.ts`),
  not wall time minus waits.
- **Adding `usage` to an adapter.** Implement the optional
  `Adapter.usage(session, cursor)` (`agents/adapter.ts`): read the vendor's
  own records of `session` (its id, worktree and account) since `cursor`
  (none for a session never read), and return a `TokenUsageReading`: a
  `ModelUsage` per model with the four counts (none for a count the vendor
  doesn't report, never 0), and the cursor to read on from, in any form the
  adapter alone parses. Charge each record to exactly one call, since
  sessions cross runs. Only read; starting the agent is `run`'s. Test it
  against fixture files, as `claude-usage.test.ts` and
  `codex-token-usage.test.ts` do. Nothing else changes: `AgentLive.run` wraps
  every call in `recordingTokenUsage` (`agents/token-usage.ts`), which
  records in a finalizer, and an adapter without `usage`, or whose reader
  fails, records the call as not reported. Flows, core and the SDK never see
  any of it.

## Run progress (#360)

An explicit record of the phase each item has reached, so a source stops
working an item's progress out from labels and review counts.
docs/adr/0019-run-progress-port.md has the why; `docs/run-progress/` holds
#361's storage test and #362's map of every recipe's handoffs.

- **A run that parks ends there**, on a daemon as in a CI job (ADR 21,
  decision 4; ADR 23, decision 2): its spoke reports `ended-at-park` and
  exits, and the hub ends the run with `CancelRunCommand` `endAs
ended-at-park`; the validity loop (`endParked`) does the same for a parked
  run with no live spoke. No run sleeps in a process: when what it waits on
  settles, the source that reads its record offers the item, and the hub
  starts a new run in a new spoke from there, after a restart too
  (`test/acceptance/hub-spokes.test.ts`). That status keeps every
  marker, worktree and session for the run that takes the item up from its
  record, as `lost` does (`RunMarkerRootOps.keptOn`), and releases the claim
  ref. A test that needs a run to stay in flight uses a durable `sleep`, not
  `awaitSignal`, and a run in flight holds a concurrency slot.
- **A flow document resumes at the node it parked on** (ADR 21, decision 4;
  `packages/sdk/src/resume.ts`). A block with `parks` records its wait with
  `resume` data: the node's id, the work item, the persona and the values the
  steps after it read, which the compiler works out (`resumeNodesOf`).
  `assemble` adds the document's `Resume.parked` source, and the generated
  flow starts a resumed run at the node. A block with `again` (a worktree, a
  cheap read) runs again rather than being kept; one with `recall` keeps
  less and reads its output back (`plan.propose` reads the plan from its
  comment). A node in a repeat's rounds resumes in its round, which the
  record keeps as `round`. A parking block whose node can't resume polls
  instead, since a park there would strand the run. When a resume entry
  duplicates a step's code, a test that edits generated code must edit every
  copy (`replaceAll`), and the flow compiler reports a type error in it once.
- **Two advances by one writer from the same phase to the same phase are one
  write**: the port takes the second as a retry of the first and keeps the
  first's data. Add data to a record in the write that makes it, as a
  document's `plan.awaitAnswer` writes the spec's `proposed` record itself
  rather than amending `plan.propose`'s.
- **The record is the only progress** (`docs/adr/0021-one-ledger-the-forge-is-input.md`).
  A source finds where an item is from its record. Labels, review counts,
  assignees and comment markers are intent, fact or projection, never
  progress. A wait on a person or another system records a phase and ends
  the run, on a daemon as in CI, and the source that reads that phase
  reports an item a run may start, not only a wake.

- **The port is core's `Progress`** (`packages/core/src/services.ts`):
  `read(item)`, `readAll` and `advance(item, { from, to, by, data? })`, a
  compare-and-set that writes `to` only if the phase is still `from` (none:
  no record yet). A record is `{ phase, from, by, version, at, data }`; the
  version is opaque and changes with every record. `at` is when the store
  wrote it, by its clock (a commit's date on the git adapter). `data` is a
  `PhaseData`, a JSON object of at most 4 KB, carried for the run that picks
  the item up next and never compared (ADR 21, decision 4). On the git
  adapter it is a `Data:` trailer of one-line JSON. Pass it through the
  SDK's `Phases.record(item, to, data)`.
- **Core knows no phase.** It stores one and compares it for equality: no
  list, no order, no terminal phase (ADR 5). The SDK's phase names and a
  team's own are its callers'. Items are opaque names (`Claims.pullRequest(n)`
  and the like), which only an adapter maps to its storage.
- **No git in the contract.** No SHA, ref or branch in its types, and no
  `GitHubError`: a lost race is `PhaseMoved` (a work error), anything else
  `ProgressError` (reported), so a hosted adapter fits the same calls.
- **The format is core's** (`packages/core/src/phase.ts`): a `Phase` is
  lowercase words joined by single hyphens, at most 64 characters; a
  `PhaseWriter` (a run id, a login, an observer's name) is one line of at most
  128 characters, no spaces. The port takes only the branded types; make one
  with `Schema.decodeSync(Phase)`.
- **A retry finds its own write.** `advance` first checks whether the record
  the item holds is this very transition by this writer, and returns it
  without writing; only then does it compare phases. Pass the run's id as
  `by` from a run, so a resumed run doesn't read its own write as a lost
  race. The same move by another writer is `PhaseMoved`.
- **`advance` is fenced and reported** in a run by `ProgressCapability`, in
  `CAPABILITIES`. Outside a run (a source reconciling a fact a person caused,
  #362) nothing fences it but the compare-and-set.
- **Every adapter passes `test/progress-contract.ts`**:
  `progressContract("<adapter>", makeAdapter)`, where `makeAdapter` is an
  Effect that makes a fresh one holding no records. `test/progress-fake.ts`
  is the in-memory adapter tests use, and passes it in `test/progress.test.ts`.
  Add a behaviour every adapter must have to the suite, not to one adapter's
  tests.
- **The binary's adapter is protected branches** (#364,
  `src/modules/runs/infrastructure/runtime/progress.ts`, provided by
  `repoServices` as the persona): `chernabog/threads/<item>`, one commit per
  phase with `Phase`, `From` and `By` trailers and no file changes. The first
  phase is a root commit with the empty tree whose ref only one writer can
  create (`POST /git/refs`, 422 for the loser); later ones are
  `createCommitOnBranch` with `expectedHeadOid`. A lost race comes back as
  HTTP 200 with `STALE_DATA` or `FORBIDDEN`, so a miss reads the branch
  again: moved is `PhaseMoved`, unmoved with `FORBIDDEN` is a ruleset's
  refusal, raised as core's `ProgressUnwritable` setup error (a defect the
  engine reports, as `ReviewerSeat` does). Items can't hold a slash: the
  rulesets match `refs/heads/chernabog/threads/*` with fnmatch.
  `src/modules/runs/infrastructure/runtime/progress.test.ts` runs the
  contract over `test/github-threads-fake.ts`;
  `test/acceptance/progress-live.test.ts` runs it, and two personas' races,
  on a real scratch repo when `CHERNABOG_PROGRESS_LIVE_REPO` and
  `CHERNABOG_PROGRESS_LIVE_PERSONAS` are set, and skips otherwise.
- **Each advance is announced** (#458,
  `src/modules/runs/infrastructure/runtime/phase-announcer.ts`): the binary
  wraps its adapter, never core's port, so that after an advance that
  succeeds it sends `repository_dispatch` `chernabog-phase` with
  `{item, from, to}` as the persona, to start the repo's CI workflow (a
  thread's commits start none). A lost race sends nothing; a retry that finds
  its own write sends again; a failed send only writes a run log line. The
  team's `announcePhases: false` turns it off (`PersonaRepo.announcePhases`,
  through `repoServices`). The acceptance fake GitHub records each one
  (`github.dispatches`).
- **`doctor` checks the rulesets** (`threads-setup.ts`): missing ones, or a
  repo that can't have them, warn (writes still work, unprotected); a persona
  that doesn't bypass the write ruleset fails. The binary owns the check,
  not a flow: the adapter is the binary's, and no flow knows a branch.
  `website/src/content/docs/operate/progress.md` has the setup commands.
- **The review loop runs on phases** (#365): implement, review, re-review,
  address-review and resolve-conflicts. The SDK's `Phases` (`phases.ts`)
  holds the names and the helpers: `record(item, to)` in a run, from
  whatever the item holds and nothing when it's there already; `records` and
  `recordOf` for a source; `reconcile` outside a run; `keyFor`.
- **Record inside the SDK function both forms call**, inside the activity
  that makes the handoff, never in a block wrapper or a recipe: a document
  and a TypeScript recipe then record alike, and a replay of a finished
  activity writes nothing. `Implement.handOff` / `Hybrid.handOff`
  (`recordHandOff`: the pull request's `review-asked` or `draft`, then the
  issue's `handed-off`), `Review.round` / `recheck` (`postReview`:
  `changes-asked` or `approved`), `Review.requestAgain` and
  `Review.askApproverAgain` (`review-asked-again`), `holdWhileBaseRed`
  (`merge-held`), `PullRequest.readyForPerson`, and the issue's
  `asked-questions` and `awaiting-ready`. A new recording step is a new
  activity (`merge-held-pr-7-1`, `awaiting-ready-7`); never rename one.
  `progress.advance` records on the item `Blocks.assemble` gives it
  (`Phases.RecordedOn`), in `progress-<node>[-round][-lane]`.
- **Sources read through one function** each, which the catalogue's source
  and the recipe's trigger both call: `Review.requestedFirst`,
  `Review.requestedAgain`, `Review.changesToAddress`. Facts (open, head,
  requests, reviews) and intent (`auto:needs-human`) stay read from GitHub;
  closed and merged pull requests aren't listed, which ends their record. A
  record GitHub disagrees with is a `held` item with why; a fact no run
  recorded (a person's review or request) is reconciled by the source that
  picks the item up, as `observer:<source>`. Work is keyed by the record
  (`Phases.keyFor`, `pr-7-changes-asked-1a2b3c4`).
- **Migration**: an item with no record is read as before, by review counts,
  with the old keys (`legacyAsked`, `legacyChanges` in `review.ts`). Drop
  them a release after this one. Wakes still read their markers
  (`baseTurnedGreen` needs the parked run's key, which no record holds), and
  post-merge, plan and epic record and read nothing yet.
- **Tests**: `test/sdk-fakes.ts` keeps one progress store per fake
  (`fake.phases()`, `fake.recordPhase`); `observe` compares the phases a
  document's run and its recipe's leave. The acceptance fake GitHub answers
  the threads adapter's GraphQL over its bare repo.

## Runs on GitHub Actions (#455)

A repo can run flows on GitHub-hosted runners instead of a daemon.
docs/adr/0020-flows-run-on-github-actions.md has the why,
`docs/ci/runner-test.md` what #456 found on a real runner, and the website's
`operate/github-actions` page the setup, cost and security.

How a CI run differs from a daemon run:

- **No daemon, no state.db to keep.** `ci plan` (the plan job) and `ci run`
  (one item on one runner) each run in a fresh `CHERNABOG_HOME`
  (`$RUNNER_TEMP/chernabog`), whose machine config they write themselves
  (`ciMachineConfig`, `src/interface/cli/ci-run.main.ts`): the checkout
  enrolled for the repo's `ci.flows`, as the implicit persona (the job's
  `GH_TOKEN`, the `CHERNABOG_TOKEN` secret), with `claude` under tmux on
  `CLAUDE_CODE_OAUTH_TOKEN`. Never write that config outside Actions. When
  config.yaml names `apps:` (#477), each App's `<slug>[bot]` login is instead
  a persona whose token is `GH_TOKEN`: `GITHUB_TOKEN` in the plan job, the
  App's installation token in a run job. Neither token can read `GET /user`,
  so the login always comes from config.
- **The plan reads claims, not state.db.** An item already has a run when it
  has a live claim, and live claims count against a flow's concurrency.
  Otherwise it applies a tick's rules (`plan-tick.handler.ts`).
- **A job ends at a phase boundary.** Where a daemon run parks, `ci run`
  lets go of the claim and exits 0; the event that settles the wait starts
  the next job. Its claim is a short lease it renews.
- **A wait for CI parks only where the flow can resume** (#513).
  `Implement.waitForCi` with a `park` item, in a CI job (`RepoSettings.ciJob`,
  set by `asCiJob` in `ci-run.main.ts`), records `awaiting-ci[-n]` on that
  item and parks on `ci-settled`; the flow's trigger then holds the item
  while CI pends (`Implement.waitingOnCi`) and resumes from the record
  (`Implement.awaitingCi`, `Review.fixesAwaitingCi`). A flow that passes no
  `park` polls inside the job, as every flow does on a daemon.
- **A failed CI run is never resumed.** The runner and its journal are gone.
  The next job repeats the phase from its start, from the work-in-progress
  commit `ci run` pushed. The run log and transcripts it copies to `--logs`
  are uploaded for diagnosis only.
- **Events start plans; a sweep backs them.** Flows declare the GitHub events
  that wake them (`packages/sdk/src/events.ts`), guarded by
  `author_association` and by the flow's own persona, and phase advances are
  sent as `repository_dispatch` `chernabog-phase`. Never let a flow wake on
  `pull_request_target`, and never list chernabog's own workflow under
  `workflow_run`.
- **The workflow is generated.** `CiWorkflow.build`
  (`src/modules/runs/domain/domain-services/ci-workflow.domain-service.ts`)
  writes it and `doctor` checks it; `action/action.yml` is glue around the
  binary. Change the builder, not a repo's workflow file.
- **Still interactive, still subscription-billed.** `ci run` refuses to start
  while `ANTHROPIC_API_KEY` is set, and seeds `~/.claude.json` so `claude`
  starts at its prompt.
- **On a machine, `ci run --run` is a spoke** (ADR 23, #658). A hub has
  recorded the run and attached its execution (`StartSpokeRunCommand`) and
  hands it over:
  `ci run --run <id> --repo --flow [--persona] --item <key> --hand-over-file <path> [--tree <sha>]`
  (or `--hand-over <json>`: a `SpokeHandOver`, the run as the hub recorded
  it and its item; no `--persona` is the implicit one; `--tree` is the
  `.chernabog/` tree the hub trusted). It runs in the machine's own home,
  writes no machine config, takes no `state.db.lock`, doesn't ask the
  trigger again, and runs the repo as the machine does (no `asCiJob`).
  `ExecuteRunCommand` executes the recorded run in its own journal, and the
  spoke follows it (`PollExecutionQuery`) to its boundary, ending nothing in
  state.db: it reports how its run ended (`ReportRunEndedCommand`, a
  `RunEnded` row in the journal's `spoke_reports`), and a park as
  `ended-at-park`, which it hears from its own engine (`flowLayer`'s
  `onParked`, once the wait is recorded), not from state.db. It stops as on
  SIGTERM when its stdin closes. **It writes nothing to `state.db`** (#661):
  `flowLayer` keeps a run's records through `RunRecords`
  (`infrastructure/runtime/run-records.ts`), which a spoke provides over its
  journal (`SpokeEngineAt`): each record is a row in `spoke_reports`, the
  runs' command it would have dispatched (`spokeReportCommands`), encoded
  with that command's own schema. It reads its run from the hand-over, the
  markers it holds from its own reports, and a session's token cursor from
  its own reports or, failing those, `state.db` read-only and query-only:
  the one read a spoke makes there. Its runs module stands over an empty
  store in memory.
- **A process with no hub is its own** (ADR 23 d9, #665): the foreground
  `run`, `rehearse` and `ci run` under Actions (`src/interface/cli/own-hub.main.ts`).
  It records the run with `StartSpokeRunCommand`, records itself as the
  run's spoke (`RecordSpokeCommand`, its own PID), executes it with
  `ExecuteRunCommand` against a journal whose `RunRecords` append to
  `spoke_reports` (`journalRecords`, reading its run and cursors back from
  its own `state.db`), folds that journal as the hub does
  (`report-fold.server.ts`'s `foldSpoke` and `foldInStateDb`, its fold
  position in `om_spokes`), and ends the run from its boundary as the hub
  ends a spoke's (`endAsSaid`): a park ends it `ended-at-park`, with no wait
  in the process. A foreground `run` that finds its flow's run still
  running ends it `interrupted` once no live process owns it
  (`takeOverLeftRun`, by the PID and start time `om_spokes` keeps), and
  refuses while one does.
- **A run a stopped process left closes its agent's sessions** (#665): the
  foreground takeover and the hub's reap end it with `CancelRunCommand`
  `closeSessions: true, sparePersonSessions: true`, since the run that owned
  the sessions is dead and the run that repeats its phase would work beside
  them. A session a person works in (its launch record's `withPerson`) stays
  open, and the ending says so. A person's own `cancel --close-session`
  closes what it asks to.
- **The daemon is the hub** (ADR 23, #659): it executes no flow itself,
  and registers none in its engine; `architecture.yaml`'s `hub-runs-no-flow`
  refuses a call to `flowLayer` or `ExecuteRunCommand` under
  `src/interface/daemon/` (#665). A
  tick records each run with `StartSpokeRunCommand` (the run and its
  execution, keyed by the run, in one unit of work, so only that tick starts
  a spoke) and spawns its own executable as the spoke, leading a process
  group of its own (`src/platform/process-group.ts`), with its hand-over in
  `spokes/<run>.hand-over.json` and a stdin pipe it holds
  (`src/interface/daemon/spokes.server.ts`). While the spoke lives the hub
  tails its journal (ADR 23 d8; a watch of `journals/`, a poll every 2
  seconds): it folds each new report (`ReadSpokeReportsQuery`) by
  dispatching its command on the hub's `CommandBus`, so status, `/events`
  and the dashboard see a spoke's steps as they'd see the hub's own; a
  report it can't read or refuses goes to the run log and is skipped. Each
  report's command and the spoke's fold position past it
  (`AdvanceSpokeFoldCommand`, `om_spokes.folded_seq`) commit in one
  state.db transaction (`foldInUnitOfWork` over `RunsModule.unitOfWork`,
  whose commands' own units of work join it as savepoints), so a report
  takes effect once whatever stops the hub.
  When the spoke exits, the hub folds what's left, then
  reads its ending (`ReadSpokeEndingQuery`) and ends the run with it
  (`FinishRunCommand`, or `CancelRunCommand` `endAs ended-at-park`); one that
  said nothing (a crash, a SIGKILL from outside) ends `interrupted`, with how
  it exited, as the reap ends one, so its phase repeats, until `spokes:
silentExits` (3) runs of its item in a row have ended so: that one ends
  `failed` (`silentExitEnding`, the count in `om_runs.silent_exits`, read by
  `ReadSilentExitsQuery`). The run's ending releases
  its markers and deletes its journal, in the hub. A run the hub ends while
  its spoke lives (cancelled, lost, superseded) ends the spoke first (ADR 23
  d5, #662): `CancelRunCommand` asks `RunSpokesClient.end`, which the hub
  provides through its `FlowRegistry` (`spokes`; no other process has any).
  The hub records the ending it means for the spoke, the cancel request it
  was asked (`SpokeEndRequest`: `by`, `closeSessions`, `endAs`), in memory
  and on its record (`IntendSpokeEndingCommand`, the first one wins), so it
  won't end the run from the exit; SIGTERMs the group,
  SIGKILLs it after 10 seconds, and waits for the exit and the last fold.
  Cancel then deletes the journal, records the ending, cleans up, and only
  then answers. A spoke reports each agent session it opens
  (`AgentSessionOpened`, beside `recordRunSession`), which the hub keeps on
  the live spoke rather than folding; `--close-session` closes those by
  their launch records' handles. `concurrency` counts running runs,
  which are the live spokes; the hub renews their leases; a reload or a
  drain starts no spoke and waits for none to be live.
- **Spokes die with the hub, and the next hub reaps them** (ADR 23 d7,
  #664). The hub records each spoke it spawns in `om_spokes`
  (`RunSpokeRoot`, `RecordSpokeCommand`): its PID (its process group's
  too) and start time as `ps` says it, the hub's, the fold position and the
  intended ending; a run's ending forgets it (`ForgetSpokeCommand`, from the
  hub's `daemon/spoke-endings` subscription). A spoke whose stdin closes
  SIGTERMs its own group (`stopWhenStdinCloses`), and a spoke stopped by
  any SIGTERM or SIGINT (its stdin, a hub's stop, a cancel, a bound)
  SIGKILLs what's left of its group on its way out (`killGroupOnStop`), so
  what it started, even what ignores SIGTERM, doesn't outlive it. A
  hub that stops SIGTERMs every spoke and waits for none. Before its first
  tick, a hub reaps every record (`ListSpokesQuery`, `Spokes.reap`): it
  signals a group only once its leader's start time and command line
  (`--run <run>`) say it is still that spoke (`isSpoke`, `processIdentity`;
  a reused PID is left alone, never killed by name), SIGTERM then SIGKILL
  after the grace, waiting until the group is gone (`endForeignGroup`);
  folds the journal from the recorded position, collecting every
  `AgentSessionOpened`; and answers `RunSpokesClient.end` for it as for a
  spoke it ended. It then ends each run still running through
  `CancelRunCommand`: with the intended ending if one was recorded, else
  `interrupted` (it keeps its markers and lets go of its claim ref, so the
  phase repeats in a new run); a journal it couldn't read says so in the
  run's summary. `test/acceptance/hub-reap.test.ts` kills a hub with
  SIGKILL under a spoke with a child that ignores SIGTERM and one spinning
  synchronously, and under a cancel.
  `SweepJournalsCommand` then deletes the journals of runs that have ended.
- **The hub bounds every spoke** (ADR 23 d4, #663): telemetry bytes,
  run-log bytes, phase time, idle time and its process group's memory,
  machine config's `spokes:` over `DEFAULT_SPOKE_BOUNDS`
  (`src/kernel/spoke-bounds.value-object.ts`). `hubSpokes` samples every
  live spoke every 5 seconds (`SAMPLE_EVERY`): telemetry and log by size,
  idle from when its journal, run log or a reported session's
  `transcripts` (`Adapter.transcripts`; claude's) last changed, memory from
  one `ps -A -o pgid=,rss=` (`groupsMemory`). One past a bound is ended
  through `CancelRunCommand` `endAs failed`, its summary naming the bound
  (`breachSummary`), with `closeSessions: true` always. The spoke caps its
  own writes too: the hub passes `--telemetry-limit` (its files are
  `spoke-<run>-<pid>.jsonl`, counted over every day folder,
  `telemetryOfArgs`) and `--run-log-limit` (`RunLogLimit`), and
  `--stop-after-seconds` five minutes past its phase-time bound, so the
  hub's bound ends it first.

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
  `incompatible`. `UpgradeRepoCommand` (`chernabog recipes upgrade`) moves a
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
  `CancelRunCommand` with `endAs needs-human`. A run resumes against the snapshot of
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

### Mutation testing (#574)

A nightly run mutates the domain and concurrency core and files one issue per
module, "Surviving mutants in _module_", that lists the mutants no test
noticed. website/src/content/docs/contribute/mutation-testing.md is the long
form; docs/testing/mutation-baseline.md and docs/testing/mutation-spike.md
have the history.

- **In scope** are the modules with a config in `stryker/`: progress, phase,
  phase-announcer, phases, ledger, progress-anomalies, ci-wake and claims.
  Each names what it mutates and an explicit `testFiles`. The CLI, the
  dashboard, the website and `test/acceptance/` are out of scope; never add
  an acceptance test to a selection.
- **Reproduce** with `bun run mutation <module>` and open
  `reports/mutation/<module>/mutation.html`. Add `--mutate 'file.ts:L-L'` to
  mutate only some lines. Or apply the mutant by hand, run the config's
  `testFiles` with `bun test`, and put the line back.
- **A run rewrites the tree in place** and restores it from `.stryker-tmp/`
  when it ends, so don't edit files or run other tests until it does.
- **Killing a mutant** takes a test that fails with the mutant applied,
  passes without it, and asserts on behaviour a caller or person would see.
  Reject, in your own work and in review:
  - a test that imports the constant it pins (`THREADS`, `PHASE_EVENT`):
    it passes on `""` too, so write the literal the outside world relies on;
  - a test that restates the code, recomputing the answer the way the
    implementation does;
  - a test that spies on internals or counts calls.
- **An equivalent mutant** is one no caller can tell apart. Mark it on the
  line before with `// Stryker disable next-line <mutator>: <reason>`, or a
  `// Stryker disable <mutator>: <reason>` and `// Stryker restore <mutator>`
  pair where a comment can't sit on its own line. The reason says why no
  caller can tell; "no test notices" is not a reason. A mark that would also
  hide a killed mutant of the same mutator on the line is wrong: leave that
  survivor listed.
- **A Timeout on a static mutant is unverified**, not killed: a static
  mutant runs the whole selection, and a slow test under load times out
  too. Rerun it with a larger `timeoutMS`. A Timeout on any other mutant is
  a kill.

## Behavior specs (#576)

A `.feature` file in `test/features/` is a spec that a person owns. It runs
through drivers (in-process, sandbox, later ci and live), so one scenario
checks more than one way of running chernabog.
docs/adr/0022-behavior-specs-in-gherkin.md has the why.

- **Drafting a feature.** Draft it from the issue, never from code that
  already exists. Write outcomes a person would say ("bob's review run stays
  parked"), never mechanism ("the daemon polls `/runs`"). A person should be
  able to follow a scenario in about 30 seconds; split one that is bigger or
  lower-level. A draft is a spec only once a person has proofread, edited
  and approved it.
- **Driver tags.** Tag the Feature or the Scenario with the drivers that run
  it: `@driver:in-process`, `@driver:sandbox`. A scenario with no driver
  tag, a tag no driver answers, or a step with no definition fails the run.
  Never make one skip.
- **Where a spec sits in a stack.** A feature is its own layer, at the
  bottom, with no step definitions or implementation. The step definitions
  and the code that make it pass are the layers above.
- **What agents own.** Step definitions, the domain layer they are written
  against (sandbox, personas, items, runs), the drivers, and each feature's
  entry files: one `.test.ts` per driver, the in-process one in
  `test/features/` and the sandbox one in `test/acceptance/`.
- **The runner** is `test/features/runner.ts`: an entry file is one call,
  `feature("review-loop", driver, steps)`, which registers a describe block
  and a test per scenario (and per outline row) the driver's tag names.
  What can't run registers a failing test that names the file and line.
  Step definitions are `defineSteps` (`test/features/steps/registry.ts`):
  `Given`/`When`/`Then` with a string pattern (`{word}`, `{string}`, `{int}`
  captures, typed) or a RegExp, matched whatever the keyword. Their bodies
  get the domain layer (`test/features/domain.ts`) and the scenario's state,
  nothing else. A new driver's name goes in the runner's `DRIVERS`, which
  already knows `ci` and `live`. A ci entry sits in `test/acceptance/`, like
  a sandbox one. A live entry that isn't configured registers one visibly
  skipped test, as `progress-live.test.ts` does: a whole driver that can't
  run, never a skipped scenario. A step that compares with an earlier event
  ("again", "the fix") compares the world's sequences (`Sequenced` in
  `domain.ts`), never a world kept from an earlier step. The
  runner's own tests and toy features are in `test/gherkin/`, outside
  `test/features/`, so they aren't specs.
- **What agents don't own.** A `.feature` file. Once a person has approved
  one, an agent may propose a change but never approve it. A pull request
  that touches a feature file is handed to a person
  (`PullRequest.handToPerson`), and only a person's approving review of a
  head with the same feature files clears it. An agent acting as the human
  on a stack never resolves that hand-off, and never removes its label.
- **The check** is `PullRequest.specGuard` (`packages/sdk/src/spec-guard.ts`,
  block `pr.specGuard`): first in the review, re-review and address-review
  recipes and documents, and in `PullRequest.merge` before it merges. A
  person is a trusted login (`SubmittedReview.trusted`) that is none of
  `Repo.personas` and no bot; feature files are compared by their blobs at
  the approved commit and the head (`GitHub.treeFiles`). It reads only
  GitHub's reviews, never chernabog's own comments or markers, and hands off
  again on every run until a person approves.
- **When a scenario fails,** fix the code, the step definitions or the
  driver. Never edit the feature to make it pass.
- **Not everything is a feature.** Combinatorial coverage stays in the
  TypeScript scenario tables (`test/compose-scenarios.ts`). Don't port
  `test/acceptance/` wholesale.

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
  `buildRepoContext` provides); `PlanTickCommand` starts none of those and
  returns them in `TickPlan.routed.waiting`, which `status` lists.
  `enroll` reads the untrusted checkout and imports no flow, so it says
  nothing of the pool.
- **`src/` names no recipe.** `local/no-recipe-names`
  (`tools/oxlint/local/`, scoped to `src/` in `.oxlintrc.json`) refuses a
  string that is a recipe's name and a regex over the SDK's vocabulary;
  learn what a flow does from what it declares through core instead.
- **A span attribute is an ID or a name.** Spans are written to disk and kept
  for 30 days, so `local/no-secret-span-attributes` refuses a secret-named key
  (`token`, `auth`, `session` but for `session.id`, …), a value read from
  something named like a secret, and a whole prompt, body or environment, in
  `spanAttributes` maps (and consts named `*SpanAttributes`),
  `Effect.annotateCurrentSpan`, `Effect.annotateLogs` and the `attributes` of
  `Effect.withSpan` and `Effect.fn`. Record an ID, a name or a length instead.
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
  `CheckRunLeasesCommand` (`FlowsClient.lease`) every `limits.leaseRenewEvery`,
  for `leaseTtl`, and reads them before each stillValid
  check; a claim naming another run ends the run as `lost` (`CancelRunCommand`
  with `endAs lost`, which removes nothing). In the run, `fencing` in the
  engine checks `Claims.holds` before every write a capability port declares
  (`Capabilities.declare` beside each port in core's `services.ts`, listed in
  `CAPABILITIES`; the claim refs' own writes are declared `claim` and never
  fenced), and a lost claim ends the workflow as `lost`. `reportingChanges`
  reports the same writes, and `recordingCreatedIssues` records in the run's
  journal (`om_created_issues`) each issue made by a write declared with
  `creates: "issue"`, which `ReadRunMadeQuery` reads back with the run's claim
  refs for `rehearse`'s cleanup. The engine names no port method: a new write, or a
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
  (`src/interface/cli/start.main.ts`) asks the daemon to run on
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
  session API's stop route reads it from the session's `launch.json` and
  never blocks for the answer; the session stays open after
  answering; a session the person closes fails the call. The session's env
  carries `CHERNABOG_SESSION`, which `chernabog open-pr` (`src/interface/cli/open-pr.main.ts`)
  uses to write the answer and `done` once the worktree is clean.
- `Hybrid.handOff` posts a `SessionMarker` with `withPerson: true`, so
  `address-review` reopens the person's session (consider, address, local
  gate and CI fixes). The pull request is labelled `labels.hybrid`, which no
  flow reads; it never carries `auto:ship`, so a person merges.
