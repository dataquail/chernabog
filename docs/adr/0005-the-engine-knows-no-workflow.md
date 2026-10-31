# 5. The engine runs flows; it knows no workflow

Status: accepted, 2026-10-29. Epic #201; landed with #202. It narrows
[ADR 0004](0004-core-abi.md)'s decision 1, which lists "the conventions the
daemon itself acts on" as core's.

## Context

Core (ADR 0004) is the binary's contract with every repo's flows. It grew to carry one workflow's vocabulary: an issue becomes a pull request on one base branch, CI gates it, a reviewer from a pool approves it, and a label ships it. That vocabulary is in core's settings (`Labels`, `Limits`, `reviewers`, `baseBranch`), in its ports (`ciState`'s verdict, `queuedIssues`), in the engine (routing by assignee and review request, fencing by `GitHub` method, a run's `pullRequest`), and in the binary, which recognizes the `implement`, `review` and `human-initiated` recipes by name and by their source.

A repo on git flow, one with no required CI, or one that doesn't review pull requests can't be served by a different recipe, because the assumptions are below the recipes.

## Decisions

1. **The engine runs flows durably and knows nothing of what they do.** It owns durable execution, signals, claims and leases, markers, scheduling, personas, and resource gates (usage, active hours, concurrency). It does not know about issues, pull requests, reviews, CI, labels or branches beyond the one branch it reads trusted config from.

2. **Claims are the engine's correctness; routing is a flow's preference.** One run per item is guaranteed by the claim, its lease and fencing. Which persona starts which item is the flow's decision, made in its trigger or a hook it defines. The engine provides the persona, not a filter language.

3. **Capability ports report facts and carry out requests.** `GitHub`, `Git`, `Worktree` and `Agent` hold no policy. A port returns what GitHub says (each check, required or not, and its state), never a verdict; a block in the SDK decides what gates a merge. A port takes what it acts on as arguments (the base a branch starts from), never from settings.

4. **Core keeps no labels.** Which labels exist and what they mean is each flow's: a flow declares its own, `chernabog labels` creates what the loaded flows declare, and a set several recipes share is an SDK export.

5. **The config branch is GitHub's default branch.** The branch the engine reads and trusts `.chernabog/` from is the remote's `HEAD`, read on every snapshot, with no setting in config or on the machine. It can't be a key in `config.yaml`, which would name the branch to read itself from, and a per-machine setting lets machines disagree about what code a repo runs. A team that wants config to take effect from another branch changes GitHub's default. Trust still approves the tree, whichever branch it came from.

6. **Settings split by owner.** Core's settings are what the engine reads: identity, schedule, concurrency, leases, launcher, agents and accounts. Everything else is a flow's, declared by a schema the flow exports and read under `flows.<name>`, so a recipe can add a setting without a core release.

7. **The engine guards and reports writes by capability, not by method.** Fencing and change reporting cover every outward write a capability makes, by a property of the capability, so a new port or method is fenced without the engine naming it.

8. **A run relates to subjects, not to a pull request.** A run may name the items it touched (any work-item keys); the live view and status thread runs by them.

9. **The binary never recognizes a flow.** No recipe name or source pattern appears in `src/`. What the binary says about a flow, it learns from the flow: diagnostics a flow contributes to `doctor`, why an item waits (beside `held`) for `status`, and which flow is the entry point for `chernabog start`.

## Consequences

- Core's surface shrinks, which ADR 0004 says is a major. Nothing is kept for compatibility: the recipe settings, `WorkItem.assignees` / `reviewers`, `RunInfo.pullRequest`, the `queuedIssues` pair and `ciState`'s verdict are removed, not deprecated, and config keys are renamed or dropped freely. A repo on the old core runs again once it upgrades its SDK and recipes.
- The SDK takes on what core loses: label sets, limits, the reviewer pool and the merge gate become blocks with their own settings. A recipe for git flow, or one without review, is a recipe, not a core change.
- Doctor and status lose their built-in knowledge of review, and get it back only from flows that contribute it. A flow that contributes nothing gets no warnings, which is the price of the binary not guessing.
- A lint rule (`architecture.yaml`) keeps recipe names and SDK vocabulary out of `src/` and the engine, the way `daemon-reaches-no-sdk` keeps the SDK's code out.

## As it lands

The epic's tasks land one at a time, each additive to core within its 1.x major, and the removals wait for core's next major, made in one release once every task is in:

- Decision 6 (#202): a flow declares `settings` and reads them through `FlowSettings`; config.yaml's `settings:` and `flows.<name>.settings`, and machine config's `flows.<name>.settings`, set them; the SDK's blocks read theirs from them (`Settings`). Core's recipe settings (`Labels`, `DEFAULT_LABELS`, `Limits`, and RepoSettings' recipe keys) and config.yaml's old keys stay, deprecated, as what a flow's settings fall back to; `reviewTrigger` loads and does nothing.
- Decision 5 (#203): snapshots, trust, the daemon's reload and doctor read `.chernabog/` from the remote's `HEAD` (`git ls-remote --symref origin HEAD`, recorded as the checkout's `origin/HEAD`), and machine config's `repos[].baseBranch` is gone (the migration drops it). The integration base is the SDK's `Settings.base` (`base` under `settings:` or `flows.<name>.settings`); config.yaml's `baseBranch` and `RepoSettings.baseBranch` stay, deprecated, as what it falls back to, and with neither it is the repo's default branch.
- Decision 3, for the integration base (#203): `Worktree.ensure(branch, { from })` takes the base a new branch starts from and fails without one; a string run id in its place, as an older SDK calls it, still starts from `RepoSettings.baseBranch` until core's next major. The claim-branch marker records its `base`, and cancel compares with the base the claim recorded. The merge block treats a pull request as a stack layer only when its base is another open pull request's head and isn't the flow's `base`.
- Decision 4 (#202): the bundled recipes declare their labels, and `chernabog labels` and `doctor` create and check only what the loaded flows declare. Core still exports its label set, deprecated, until its next major.
- Decision 3 (#207): `GitHub.ciChecks` reports a pull request's check runs and commit statuses, each with its state and whether the base requires it, and the SDK's `Ci.verdict` decides green, red or pending by the flow's `ciGates` and `ciOptionalFailures`. `ciState` and `commitCiState` keep their verdicts, and `queuedIssues` and `oldestQueued` their read of the `eligible` label, deprecated until the major; no SDK block calls them. Cancel no longer removes the claim label; the run's label marker releases it.
- Decision 2 (#204): a trigger leaves an item for others by giving the reason (`WorkItem.elsewhere`), as it holds one with `held`; the engine starts none of those unless a person names one, and `status` lists them with the reason. The SDK's `Routing` block filters by GitHub's `assignee:` / `review-requested:` qualifiers, read from the flow's `assignee` and `reviewRequested` settings, and the bundled recipes route with it. The engine reads no assignee or review request. `WorkItem.assignees` / `reviewers` stay in core, deprecated and unread, until its next major; config's `flows.<name>.assignee` and `reviewRequested` stay too, deprecated, given to the flow as those settings.
- Decision 9 (#208): a flow contributes `doctor` checks (`defineFlow({ doctor })`, each a `DoctorCheck` given the machine's personas, the persona it runs as and the repo's flows, with that persona's settings), and the SDK's `Review.poolCheck` and `Review.reviewerCheck` are the reviewer-pool checks the recipes that ask for and give reviews include; `poolCheck` counts a flow that includes `reviewerCheck` as one that reviews. A trigger says who an item waits on, and why (`WorkItem.waitsOn`, beside `held`), which `status` lists; the review recipe reports the requests no persona here serves this way (`Review.waitingElsewhere`, from core's `Machine` service). `chernabog start` runs the flow that declares `defineFlow({ start: true })`, and refuses a repo with none or several. The binary's recipe names, flow-source patterns and `FlowsClient.reviewRequests` are gone, and `local/no-recipe-names` (`.oxlintrc.json`, scoped to `src/`) refuses a recipe's name or a pattern over the SDK's vocabulary there: goodbones' `architecture.yaml` matches imports and declared names, not string literals.
