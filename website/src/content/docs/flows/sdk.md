---
title: SDK services
description: The services @chernabog/sdk provides to flows and Effect steps.
---

The services are [`@chernabog/core`](https://www.npmjs.com/package/@chernabog/core)'s ports, which `@chernabog/sdk` re-exports; the binary provides them, from its own copy of core, to the SDK each repo installs. Each service is a layer, so a team can replace one with its own implementation, and tests can use fakes.

| Service    | Covers                                                                      |
| ---------- | --------------------------------------------------------------------------- |
| `Repo`     | the repo's merged settings: slug, base branch, reviewer pool, labels, limits, gates, notes |
| `Run`      | the run: flow, run id and work item                                         |
| `GitHub`   | queued issues, claims, labels, comments, branches, pull requests, review requests and reviews, CI state, merges |
| `Agent`    | starting and resuming agent sessions through an [adapter](/chernabog/agents/adapters/); `withPerson` on a request opens the session [in front of a person](/chernabog/agents/launchers/#with-a-person) |
| `Git`      | commits ahead, changed files, pushes                                        |
| `Worktree` | one worktree per branch                                                     |
| `Usage`    | the account check and the [usage gate](/chernabog/agents/usage-gate/)        |
| `ReviewerSeat` | the persona's seat in the reviewer pool, which every block that reviews requires; checked before a flow runs (see [Errors](/chernabog/flows/flows/#errors)) |
| `RunLog`   | the run's log                                                               |
| `Runs`     | whether a run this machine knows is still going; given to triggers, read with `Effect.serviceOption` |

```bash
cd .chernabog && bun install   # or npm, pnpm: dev dependencies, for the editor
```

## The label contract

Labels are how people see where work stands, and how some flows hand it on. Pull requests pass between `implement`, `review`, `address-review` and `re-review` through GitHub's review requests and reviews instead. A flow that composes its own sequence from the building blocks has to leave the labels the way the other flows expect them. The names are a [flow setting](/chernabog/reference/configuration/#flow-settings), `labels`; the ones here are the defaults. A flow declares the labels it uses, `labels: Settings.declaredLabels` for this set under the names its settings give, and `chernabog labels` creates what the loaded flows declare.

| Label                      | On    | Means                                     | Set by                                                          | Removed by                                     | Read by |
| -------------------------- | ----- | ----------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- | ------- |
| `auto:eligible`            | issue | queued                                    | a person; `Plan.create`, on an `auto` task                      | `Implement.claim`, `Hybrid.claim`              | `implement`'s trigger, which holds an issue an open issue blocks, and a task of an epic an epic run holds (`Implement.queued`) |
| `auto:ship`                | both  | queued, or on a pull request: the automated path, which chernabog merges once approved | a person, on the issue; `Implement.openPullRequest`, on its pull request | `Implement.claim` and `Hybrid.claim`, on the issue | `implement`'s trigger; `PullRequest.ships`, which `shipping` and `mergeOrLeave` ask |
| `auto:in-progress`         | issue | a run owns the issue                      | `Implement.claim`, `Hybrid.claim`                               | `handOff`, `handToHuman`, `askForClarification` | people |
| `auto:needs-clarification` | issue | questions are on the issue                | `Implement.askForClarification`                                 | a person, on requeue                           | people |
| `auto:needs-review`        | PR    | open and green, with no reviewer in the pool; a person reviews | `PullRequest.requestReview` (so `Implement.handOff`) | a person | people |
| `hybrid`                   | PR    | a person worked on it with an agent; a person merges | `Hybrid.openPullRequest` | a person | people; no flow reads it |
| `auto:needs-human`         | both  | a cap or rule stopped it; a person takes over | `Implement.handToHuman`, `Plan.handToHuman`, `PullRequest.handToPerson`, `PullRequest.mergeOrLeave`, the `address-review` flow; `Plan.create`, on a `human` task | a person | the `re-review` and `address-review` triggers, which skip it; no flow picks it up again |
| `auto:plan`                | issue | a spec queued for a plan                  | a person                                                        | `Implement.claim`                              | `plan`'s trigger |
| `auto:plan-proposed`       | issue | a plan is posted and waits for a person   | `Plan.propose`                                                  | `Plan.changesAsked`, `Plan.becomeEpic`, `Plan.handToHuman` | `Plan.answers`, in `plan`'s trigger |
| `auto:plan-approved`       | issue | a person approved the posted plan         | a person                                                        | `Plan.becomeEpic`                              | `Plan.answers`, in `plan`'s trigger |
| `auto:epic`                | issue | an epic of sub-issues a plan made         | `Plan.becomeEpic`                                               | a person                                       | `Implement.queued`, which leaves the tasks of an epic an epic run holds to that run; people |

`auto:approved`, `auto:stale` and `auto:changes-requested` stay in the label set, and `chernabog labels` creates them, but no recipe sets or reads them.

Most steps only post. The ones above that move labels say so; `Review.round` and `Review.recheck` post a review and move none.

**What a flow leaves behind at each ending.**

- **The issue** never keeps `auto:in-progress` once its run ends: the run that claimed it is the only thing that removes it. `handOff`, `handToHuman` and `askForClarification` each remove it; a flow that ends another way removes it too.
- **A pull request handed on for review** has a review requested of one reviewer from the pool, or `auto:needs-review` without one, and the session marker `handOff` posts, so the `address-review` flow can resume the session that wrote it. A review request starts `review` as that reviewer, and a second one, after it reviewed, starts `re-review`.
- **A pull request the run reviewed itself** carries `auto:needs-human` or no label. A review that requests changes on the current head starts the author's `address-review`, so post one only when that is what should happen next, or hand the pull request to a person.
- **A merge** happens only through `PullRequest.mergeOrLeave`, or behind a check of `PullRequest.ships`, so chernabog merges nothing that doesn't carry `auto:ship`.
- **Worktrees** of a review, `review-pr-<n>`, are removed by `Review.doneReviewing(pr)`, which the `review` and `re-review` recipes call once they're done. A flow of your own that calls `Review.round` removes it the same way.

`chernabog status` lists each flow's work from its trigger, so a label left behind shows up there as work waiting to start.

## Settings

A flow declares the settings it reads with a schema, and reads them typed with `Settings.read(schema)`; a repo sets them in `config.yaml`, under `settings:` for every flow or `flows.<flow>.settings` for one ([Flow settings](/chernabog/reference/configuration/#flow-settings)). The engine checks them against the flow's schema when the flow loads, so a bad one is a config error then, not a failure partway through a run. A setting no other flow or core knows about is a key in the flow's schema:

```ts
const Own = Schema.Struct({
  ...Settings.Ci.fields,
  ...Settings.Reviewers.fields,
  promoteFrom: Schema.String,
});

export default defineFlow({
  settings: Own,
  labels: Settings.declaredLabels,
  trigger,
  workflow: (item) =>
    Effect.gen(function* () {
      const { promoteFrom } = yield* Settings.read(Own);
      // …
    }),
});
```

The SDK's blocks read their own settings, which a recipe includes in its schema: `Settings.Labels` (`labels`), `Settings.Board` (`board`), `Settings.LocalGate` (`localGate`, `localGateRounds`, `install`), `Settings.Rules` (`humanOnly`, `humanOnlyPaths`, `notes`), `Settings.Ci` (`ciRounds`, `ciTimeout`, `ciGates`, `ciOptionalFailures`), `Settings.Reviewers` (`reviewers`, `reviewRounds`), `Settings.Plans` (`planNodes`, `planRounds`) and `Settings.Stacks` (`stackDepth`). Each has a reader that fills what the settings leave out: `Settings.labels`, `board`, `localGate`, `rules`, `ci`, `ciGate`, `reviewers`, `plans` and `stackDepth`. A block reads its keys whether or not the flow's schema includes them; including them is what checks them when the flow loads and describes them in `config.schema.json`. Until core's next major, a setting the flow's settings leave out falls back to `config.yaml`'s old key, such as `limits.ciRounds`.

**CI is facts, and the gate is a block.** `GitHub.ciChecks(pullRequest)` reports every check run and commit status on the pull request's head (each with its `state`, `pending`, `passed` or `failed`, and whether the base branch requires it), the checks the base requires, and a `caveat` when GitHub won't say which those are. `Ci.verdict(facts, policy)` decides green, red or pending from them, and `Ci.pullRequestState(pullRequest)` reads both now, by the flow's `ciGates` and `ciOptionalFailures`; `Implement.waitForCi` and `PullRequest.merge` decide by it. `GitHub.ciState`, the adapter's own verdict, and `queuedIssues` and `oldestQueued`, which read the repo's `eligible` label, are deprecated until core's next major: read `ciChecks`, and call `queuedIssuesLabelled` with the flow's own label.

## Claims

A claim on an issue or a pull request is a ref of its own, `refs/chernabog/claims/<item>` (`issue-12`, `pr-73`), apart from the work branch. It points at a commit with an empty tree, whose message says whose run holds it:

```
chernabog claim

Run: 3f9c…
Persona: alice
Flow: implement
Claimed-At: 2026-10-26T14:00:00.000Z
```

Creating a ref is the one write GitHub refuses to a second writer, so the run that creates it holds the item, and `Claims.holder(item)` reads who that is. It says nothing about the machine: the ref is as public as the repo. A ref outside `refs/heads/` isn't a branch: it isn't in the branch list, and `push` workflows, which run for branches and tags, don't see it.

`Claims.acquire` holds the ref as a [marker](#markers), so however the run ends, cancelled or superseded included, the daemon deletes it. `Claims.releasing(item)(effect)` deletes it as soon as `effect` ends instead, whatever the ending; a run waiting on a signal keeps it. A run of an earlier version, which held no marker and never wrapped its claim in `releasing`, leaves the ref behind when it ends, and the issue stays held. `chernabog cancel <run>` lets it go: a run in flight is cancelled as ever, with its claim ref; for a run that has already ended, cancel deletes only the claim ref that still names it, and the run keeps its ending. The work branch stays, and so does any pull request, so a branch with no claim on it is work a later run takes up. Labels, the assignee and the claim comment are how a person sees a claim, written after it is won.

Runs of an earlier version held an issue by its branch alone. While they may be in flight, a branch whose latest claim comment names no claim ref is still theirs, and `claim` skips it.

## Markers

A marker is something a run put on an item outside chernabog, with a named way to take it off. A run holds it, and the daemon releases it however the run ends: done, failed, needs-human, cancelled or superseded. A closure can't be journaled, so a release is defined by name at the top of the flow's module, with a schema for its arguments, and listed in the flow's `markers`:

```ts
const inProgress = Markers.define(
  "jira-in-progress",
  Schema.Struct({ key: Schema.String }),
  (args) => Jira.transition(args.key, "To Do"),
);

export default defineFlow({
  markers: [inProgress],
  workflow: (item) =>
    activity(
      "start",
      Effect.gen(function* () {
        yield* Markers.hold(inProgress, { key: item.key });
        yield* Jira.transition(item.key, "In Progress");
      }),
    ),
  // …
});
```

- **Hold it before putting it on**, inside an activity, so a crash in between leaves nothing unrecorded. A run holds a name and arguments once: one that resumes and holds it again changes nothing. Holding a marker the flow doesn't list fails the step, since nothing could release it.
- **Releases run after the run ends**, newest first, from the flow as the base branch has it then, as the run's persona. A release must be safe to repeat: one that fails is tried again, backing off from 30 seconds to an hour, and `chernabog status` shows it under "not yet released" until it succeeds.
- **`keepOn`** names endings on which a marker stays: `Markers.hold(m, args, { keepOn: ["needs-human"] })` for something put there for a person to see. **`Markers.drop(m, args)`** releases one now, when the run is done with it, and `Markers.dropAll(m)` every hold of it.
- **A release the flow no longer defines** (it changed since the hold, or the arguments no longer fit its schema) isn't dropped silently: status lists it as unreleasable, with its arguments, for a person to take off.

The SDK's blocks hold markers of their own, which no flow lists (`Markers.builtIn`): `Implement.claim` and `Hybrid.claim` (and `Plan`, through `Implement.claim`) hold the claim ref, the `auto:in-progress` label, the persona's assignment, the board Status and the claim branch they create. The label goes on every ending; the assignment and board Status stay on a run that's done, since its pull request carries on, and the board moves back to its ready Status otherwise; the claim branch is deleted only while it holds no commits and no pull request, and stays on needs-human. On the hybrid path, a run that fails, as one whose session the person closes does, keeps the issue in progress for their next start.

**Ownership.** A flow that reviews and fixes its own pull request wraps that work in `PullRequest.owning(pr)`. That takes the pull request's claim, `pr-<n>`, and posts an owner marker for people to read, and when the work ends, whether it succeeded or failed, lets the claim go and posts a release marker. A run waiting on a signal keeps the pull request, and a pull request another run owns is skipped. While a pull request is owned, `Review.reviewRequests` leaves it out and `Review.ownedByARun` says so, deciding from the claim ref, so the `review`, `re-review` and `address-review` recipes don't start on it. A run this machine knows has ended no longer owns anything, even with its ref still there. One on another machine owns the pull request until its ref goes. A pull request with no claim ref falls back to the owner markers, for runs of an earlier version.

**Labels of a flow's own.** A flow keyed by its own label, such as `auto:docs`, declares it in `defineFlow({ labels: [{ name: "auto:docs" }] })`, uses `Implement.triggerFor("auto:docs")`, and claims with `Implement.claim(issue, yield* Implement.queuedBy(item))`, which removes that label in place of `auto:eligible`. `chernabog labels` creates declared labels beside the repo's own.

**A base branch per item.** The implement and hybrid blocks build on the flow's `base` setting (`Settings.base`: under `settings:` or `flows.<name>.settings`, such as `develop` in git flow; unset, GitHub's default branch) unless given a `base`, such as another task's branch for a task stacked on it, or a release branch for a fix. `Implement.claim(issue, { base })` and `Hybrid.claim(issue, { base })` create the claim branch from that base's head, record it in the claim marker and in the claim branch's release marker (which deletes a branch with no commits beyond it, as `cancel` does), and return it as `base`; a run that resumes inside claim keeps the base it recorded. Pass the claimed `base` on to `prepareWorktree` (`Worktree.ensure(branch, { from })` starts a branch origin lacks from it, and fails without one rather than guessing), `implementWithAgent` and `workWithPerson` (the prompt's `{{base}}`), `push` and `waitForCi` (which check for commits and for `humanOnlyPaths` against it, so a stacked task is judged by its own diff), and `openPullRequest` (which targets it). A base that no longer exists, as a merged and deleted branch, fails the claim with `base branch <name> not found` rather than falling back; choosing another is the flow's to do. `review`, `re-review` and `resolve-conflicts` read the pull request's own base already.

**An epic's tasks.** `Epic.tasks(epic)` reads the epic's sub-issues and each open one's blockers, and says of each open task whether it is `ready` (on `base`: the flow's `base` setting with no open blocker, or `auto/issue-<n>` when its one open blocker is an `auto` task of the epic with an open pull request, `stackedOn` that task) or `held`, with the `reason` a `WorkItem.held` carries: `waits on #12, #13` for several open blockers, `waits on #12` for one without a pull request, outside the epic or not an `auto` task, and `waits for #12's stack to merge` when stacking it would hold more than `stackDepth` layers. A closed blocker counts as done. The verify task is reported apart, as `verify`, ready only once every other sub-issue is closed. `Epic.tasks(epic, { started })` also stacks a task on one an epic run started, whose claim took `auto:eligible` off.

**An epic run.** `Epic.claim(epic)` takes the epic's claim ref (`claim-epic`) or skips the run; `Epic.stillValid` is gone once the epic closes or another run holds its claim. `Epic.progress(epic, round)` (`epic-tasks-<round>`) reads each sub-issue as a `Layer`: `ready` (with `base` and `stackedOn`), `held` (with `reason`, which it writes to the run log), `in-review` (its `pullRequest`), `person`, `merged` or `closed`, and the epic's `fingerprint`: a digest of each sub-issue's state and kind and each layer's pull request state, head and reviews. `Epic.postStatus(epic, round, progress)` (`epic-status-<round>`) keeps one status comment on the epic, carrying that fingerprint; `Epic.queued`, a trigger, reports open epics with an open task, and signals `Epic.LAYER_CHANGED` when the fingerprint no longer matches the status, so a run parked on `awaitSignal([Epic.LAYER_CHANGED], …)` wakes.

**Several issues in one run.** `Implement`'s blocks take an `id`, as `localGate` and `waitForCi` do, which names their steps for the issue (`claim#task-12`, `implement#task-12`, `hand-off#task-12`) and gives the issue its own agent session; `Implement.sessionFor({ id })` is that session, for `localGate` and `waitForCi`. `openPullRequest(issue, outcome, { partOf: epic })` adds `Part of #<epic>` under the `Closes` line.

**Keeping a stacked layer up to date.** `Stack.syncBase(worktree, { base, lower })` merges a layer's base into its worktree, as the activity `update-from-base` (`id` tells apart two in one run); `Stack.updateFromBase` is the same outside an activity. While the layer below (`lower`, its pull request) is open, it merges `origin/<base>`. Once the layer below merged, it merges the branch that one merged into: plainly for a merge commit, and for a squash or rebase of the head this layer is built on, in three steps, so this layer's edits of lines the layer below added don't conflict: the base as it was before the lower layer's commits, merged normally; those commits, recorded with `git merge -s ours` since this layer already holds exactly their change; then the rest of the base. It never rebases or pushes. It returns `clean`, the `conflicts` left in progress for the agent to resolve and commit (update again, with another `id`, to finish), the `base` the layer is now on, `oldBase` and `newBase`, what the layer's own changes were against before and the base head merged now, and `reconciled`, whether the lower layer's squash or rebase was recorded as already here. A conflict in the base before the lower layer's commits stops a reconcile short with `reconciled: false` while `oldBase` is already the lower head, so read `reconciled`, not `oldBase`, to tell whether it got that far.

**Refreshing a layer whose base moved.** `Stack.refreshLayer(worktree, { pullRequest, branch, base, lower, baseSha, attempt })` does what a layer needs after the layer below changed, outside the review rounds. It merges the base in with `syncBase`. When that conflicts, or the base changed a file the layer changes too, it resumes the author's session (the one the implementing run's session marker names, unless `session` is given) with the base's diff of those files, to resolve the conflicts and adjust the layer's own code, test first where behaviour changes; its prompt is `.chernabog/prompts/refresh.md`, or the SDK's own. A base change to files the layer doesn't touch that still breaks it is caught by the local gate or CI, which send the failure back to that session. Then it runs `Implement.localGate`, `Implement.push` and `Implement.waitForCi` against the base the layer is now on. If the agent leaves the merge unfinished or edits it didn't commit, the run goes to a person before anything is pushed. When the new head only merged the base into the head the latest review saw (`PullRequest.onlyMergedBase`, checked against the branch it merged in, even before the pull request is retargeted off a merged layer below), that review stands; otherwise its reviewer is asked again, as `Review.askAgain` does. It posts no review marker, so it doesn't count against `reviewRounds`. Every step is keyed by the pull request and `baseSha`, the base head the caller saw move, so a loop refreshes once per move. Pass `attempt` (2, 3, …) to refresh at the same `baseSha` again, as after a person hands the layer back: steps saved by an earlier attempt, failures included, aren't replayed. It returns `upToDate` (the layer already held the base; nothing was pushed), `adjusted` (the agent was asked) and `askedAgain`, the reviewer asked, if any.

**Steps and replays.** `Review.round(pr, n)` saves its result as `review-<n>`, and `Review.recheck` saves its as the next round's. `PullRequest.requestReview(pr)` chooses its reviewer once, at random, inside an activity, so a replay asks the same person.

## Subjects

A run's subjects are the work items it touched besides the one it started for, by key: `issue-12`, `pr-40`, `release-1.4`. `Subjects.name(key)` names one; naming it again changes nothing, so a run that resumes can repeat it, and outside a run the daemon records it does nothing. The daemon keeps no idea of its own of what a run touched: the live view threads runs that share a work item, as their own or as a subject, into one piece of work, a flow's `stillValid` reads them as `Run`'s `subjects`, and a GitHub notification about one checks the runs that named it.

`Implement.openPullRequest`, `Hybrid.openPullRequest` and `Implement.claim`, when it adopts a pull request, name it (`Claims.pullRequest(n)`), so an issue's run threads with the runs on its pull request, and an epic's run with every task's. `Implement.stillValid` is gone once any pull request its run named is closed or merged. A flow that opens anything else names it the same way:

```ts
yield* Subjects.name(`release-${version}`);
```
