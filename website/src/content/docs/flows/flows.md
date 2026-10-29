---
title: Writing flows
description: defineFlow, durable activities, and composing the SDK's building blocks.
---

A flow is a TypeScript module in `.chernabog/flows/` whose default export is `defineFlow`:

| Field         | Is                                                                     |
| ------------- | ---------------------------------------------------------------------- |
| `trigger`     | an Effect returning the work items in the state the flow acts on; leave it out for a [manual flow](#manual-flows) |
| `gate`        | optional; checked before each run starts — fail with `Skip` to hold it back |
| `concurrency` | runs of this flow at once                                              |
| `schedule`    | optional cron; `flows.<flow>.schedule` and the `schedule` on the repo's entry in machine config override it. Not on a manual flow |
| `labels`      | optional; labels of the flow's own, such as `{ name: "auto:docs" }`, which `chernabog labels` creates |
| `ownWork`     | optional; `true` when the trigger finds only the work of the persona it runs as, as `review`'s does by its review requests, so the daemon doesn't warn that several personas each take any of it |
| `stillValid`  | optional; `(item) => Effect<Valid \| Gone>`: whether a run's work item is still there to work on. The daemon ends a run whose item is `Gone` as `superseded`; see [Work that goes away](#work-that-goes-away) |
| `markers`     | optional; the [markers](/chernabog/flows/sdk/#markers) its runs hold, each from `Markers.define`, so the daemon can release them by name however a run ends. The SDK's own need no listing |
| `item`        | `(key) => Effect<Option<WorkItem>>`: the work item for a key a person names that the trigger doesn't report, as `Hybrid.itemFor` finds the issue `chernabog start` names. `run --item <key>` and the daemon use it. Optional, except on a manual flow |
| `workflow`    | `(item) => Effect`: the durable work for one item                      |

`trigger`, `gate`, `item` and `workflow` may fail only with the flow's own outcomes, `Skip`, `NeedsHuman` and `StepFailed`. Any other error has to be handled before the flow compiles: see [Errors](#errors).

Each step in a workflow is an **activity** whose result is saved in SQLite, so after a crash or restart the run resumes after the last completed step.

```ts
import { Claims, defineFlow, Implement, step } from "@chernabog/sdk";
import { Effect, Schema } from "effect";

export default defineFlow({
  trigger: Implement.triggerFor("auto:eligible"),
  gate: Implement.gate,
  concurrency: 1,
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);

      // However the run ends, its claim on the issue goes.
      return yield* Effect.gen(function* () {
        const { branch } = yield* Implement.claim(issue);
        const checked = yield* step("check-scope", { issue }, { output: Schema.Struct({ ok: Schema.Boolean }) });
        // ...
      }).pipe(Claims.releasing(Claims.issue(issue)));
    }),
});
```

:::caution[Replay]
The workflow body runs again on every replay. Side effects belong inside activities or steps, never in the body.
:::

## Work that goes away

A run learns that its item changed only if a trigger reports a signal it waits on, or a step reads the item again. `stillValid` says when the item is gone, and the daemon asks it of every run of the flow in flight, executing or parked:

- every `limits.validityEvery` (default `5 minutes`), whatever the flow's own schedule;
- when a signal is about to wake a parked run, before it resumes;
- at once, when a persona's [notifications](/chernabog/operate/daemon/#ticks-on-events) have news about the repo.

```ts
import { defineFlow, gone, Implement, valid } from "@chernabog/sdk";

export default defineFlow({
  trigger,
  // The SDK's check for an issue's run: open, claimed by this run or nobody,
  // and any pull request the run opened still open.
  stillValid: Implement.stillValid,
  // Or one of your own, against a client of your own:
  // stillValid: (item) => Effect.map(myTracker.ticket(item.key), (ticket) =>
  //   ticket.done ? gone(`${item.key} was resolved`) : valid),
  workflow,
});
```

A run whose item is `Gone` ends as **`superseded`**, with the reason as its summary (`#42 was closed; interrupted in implement`). An agent step in progress stops, and its session is left open, as `chernabog cancel` leaves it; any other activity in progress finishes first, and the run starts no more. Its worktrees, claim ref and claim on its issue are released as `cancel` releases them. `status`, the live view and `chernabog logs <run>` show the ending and the reason.

Before `stillValid`, the daemon checks the run's [lease](/chernabog/operate/daemon/#leases): a run whose claim another run took over, after its lease expired, ends as **`lost`** instead, leaving what it put on the item to that run.

A check that fails (GitHub down, rate limited, or past its one-minute timeout) is not `Gone`: the run carries on, the daemon's log says so once, and `status` shows the failure under the run until a check succeeds. The check runs with the persona's services, and `Run` names the run it asks about, including `pullRequest`, the one it opened.

The SDK's checks, which the recipes use:

| Check                 | Gone when                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `Implement.stillValid` | the issue is closed or deleted, another run holds its claim, or the pull request the run opened is closed or merged |
| `Plan.stillValid`     | the spec is closed or deleted, or another run holds its claim                                       |
| `Review.stillValid`   | the pull request is closed, merged or deleted, or another run holds its claim                       |

Without `stillValid`, a run carries on until its workflow ends it, as before.

## Manual flows

A flow with `item` and no `trigger` is manual: nothing finds its work, and it runs only when a person names an item, with `chernabog start <issue>` for [`human-initiated`](/chernabog/recipes/human-initiated/), or `chernabog run <flow> --item <key>` for any other. The daemon never ticks it on a schedule, and `status` shows it as `manual` in place of a schedule and its next tick.

```ts
import { defineFlow, Hybrid } from "@chernabog/sdk";

export default defineFlow({
  item: Hybrid.itemFor,
  workflow: (item) => /* … */,
});
```

A manual flow must have `item`, since nothing else could start it, and can't have `schedule`. A `schedule` for it under `flows.<flow>`, in `config.yaml` or machine config, fails the repo's config with the flow's name; the repo's and the persona's default `schedule` don't apply to it. `run` and `trigger` without `--item` fail and say how to start it.

`Hybrid.trigger`, which finds nothing, is deprecated: a flow that still uses it loads and works as before, ticking on a schedule to no effect, until `chernabog recipes diff` shows the recipe without it.

## Helpers

| Helper                                  | Does                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `activity(name, effect, schema)`        | One durable step; runs once, and a replay returns the saved result       |
| `step(name, input, { output })`         | Runs [`.chernabog/stages/<name>`](/chernabog/flows/steps/) in its own process, as an activity |
| `sleep(name, duration)`                 | A durable pause that survives restarts                                    |
| `awaitSignal(signals, { id, timeout })` | Waits for one of the signals or the timeout, and says which              |
| `renderPrompt(name, values)`            | Fills `.chernabog/prompts/<name>.md`; for a flow imported from a recipe package, the package's `prompts/<name>.md` when the repo has none |
| `Skip`, `NeedsHuman`                    | End a run cleanly, or hand its item to a person                          |
| `reportAs(step)`                        | Turns the errors a flow can only report into `StepFailed`, for a trigger or work outside an activity |

Activity names are unique within a run, so one in a loop carries its round: `fix-ci-2`.

**Signals.** A trigger reports signals in `WorkItem.signals`; a waiting run's `awaitSignal` wakes on them. Report an item with `wakeOnly` to wake a waiting run without starting a new one.

**Held work.** Report an item with `held: "waits on #12, #13"` when the trigger won't start it yet. It starts no run, even with `wakeOnly` unset, its signals still wake a waiting run, and `chernabog status` and the live view list it with the reason, so an idle queue and a queue of blocked work look different.

## Errors

Errors are split by who has to act on them.

**The flow's outcomes.** A run ends done, or fails with `Skip` (nothing to do, or a gate said not now), `NeedsHuman` (a person takes over) or `StepFailed` (a step failed, named so the run log says which). These are the only errors a flow's `trigger`, `gate`, `item` and `workflow` may fail with.

**The work's errors** are typed at the call that raises them, and the flow decides what each one means for its work. The compiler names any it leaves unhandled, so a flow that lets one through doesn't compile.

| Error               | Raised by                                                       | Carries |
| ------------------- | --------------------------------------------------------------- | ------- |
| `NotFound`          | `GitHub.issue`, `GitHub.pullRequest`, and the blocks that read them | what's missing |
| `PullRequestClosed` | `GitHub.review`, `requestReviewers` and `merge`, `PullRequest.merge` | the pull request, and whether it's `closed` or `merged` |
| `MergeRefused`      | `GitHub.merge`, `PullRequest.merge`                              | the reason |
| `PushRejected`      | `Git.push`, `Implement.push`, `waitForCi`                        | the reason, and `missingScope` when the token lacks one, such as `workflow` for a change to `.github/workflows/`; its message says how to fix the token |
| `NothingCommitted`  | `Implement.push`, when the branch has no commits and the worktree no changes (with changes, it fails with `NeedsHuman` naming them) | the branch |
| `CiTimedOut`        | `Implement.waitForCi`, when CI stays pending past `limits.ciTimeout` | the pull request, and how long |

Handle them with `Effect.catchTag` or `Effect.catchTags`, usually by handing the work to a person:

```ts
yield* Implement.push("push", worktree, branch).pipe(
  Effect.catchTags({
    PushRejected: (rejected) => Implement.handToHuman(issue, rejected.message, Option.none()).pipe(Effect.flatMap(Implement.endForPerson)),
    NothingCommitted: (nothing) => Effect.fail(new NeedsHuman({ reason: nothing.message })),
  }),
);
```

**Errors a flow can only report**, such as `GitHubError`, `GitError`, `AgentError` and `UsageError`, carry a message and nothing to decide on. An activity turns any of them into `StepFailed`, named for the activity. Outside an activity, as in a trigger, pipe the effect through `reportAs(step)` to do the same:

```ts
const trigger = GitHub.use((github) => github.queuedIssues).pipe(
  Effect.map((issues) => issues.map((issue) => Implement.issueItem(issue))),
  reportAs("trigger"),
);
```

**Setup errors** are a person's to fix in their configuration or logins. They're raised while a persona's services are built, before any flow runs, and the engine reports them; no flow sees one. Each names its fix:

| Error                | When |
| -------------------- | ---- |
| `PersonaUnavailable` | `gh auth token --user <login>` fails for a persona under `github:`: it isn't logged in, or has been logged out since |
| `NotAuthenticated`   | the implicit account has no token: no `GH_TOKEN`, `GITHUB_TOKEN` or gh login |
| `NotInReviewerPool`  | a flow that reviews runs as the implicit account, or as a login the repo's `reviewers` leave out |

The daemon records a setup error as that tick's skip reason, and starts nothing; `chernabog status`, `run` and `trigger` show it. Services are built again on the next tick while setup fails, so a persona logged in later is picked up without a restart. An error that only appears partway through, such as a token that loses a scope, stays typed at the call (`PushRejected`) and is the flow's to handle.

**A capability's setup is a service.** What a flow needs to have set up before it runs is a service it requires, which the engine checks when it builds the persona's services. Reviewing is one: every block that reviews (`Review.reviewRequests`, `round`, `recheck`, `latestOwnReview`) requires `ReviewerSeat`, so any flow that calls one requires it too. The seat holds when the persona is a login under `github:`, not the implicit account, that the repo's `reviewers` list. A flow that never reviews runs whatever the seat; one that does stops before its work, with `NotInReviewerPool` or `PersonaUnavailable` as the tick's reason. `Review.reviewerLogin` is the seat's login.

## Building blocks

`Implement`, `Review` and `PullRequest` hold the blocks of [the review loop](/chernabog/work/flows/), and `Hybrid` those of the hybrid path; each is an activity a flow can reorder, leave out or wrap. The [recipes](/chernabog/recipes/) are written out from them, and are the place to see them used.

- `Implement.issueItem(issue, label)` is an issue as a work item, with the label that queued it; `Implement.queuedBy(item)` says which label queued one, for `claim`, `askForClarification` and `openPullRequest`. `Implement.triggerFor(label)` queues issues by a label of the flow's own, paired with `claim(issue, queuedBy(item))`. `Implement.queued(issues, label)` makes issues work items too, held with the reason when one waits: `waits on #12, #13` while open issues block it, or `belongs to the epic run on #136` when it is a task of an epic an epic run holds.
- `Implement.handOff(issue, pr, outcome)` asks one reviewer from the pool with `PullRequest.requestReview`; `{ needsReview: false }` hands off without asking.
- `Review.round(pr, n, { role })` reviews in a fresh session, with the adapter of an optional role from [`flows.<flow>.agents`](/chernabog/reference/configuration/#agents-by-role), and posts a real GitHub review with a marker that records the reviewer and its session. It moves no labels, and leaves the review's checkout, `review-pr-<n>`, for `Review.doneReviewing(pr)` to remove.
- `Hybrid`'s blocks make [the hybrid path](/chernabog/work/flows/#the-hybrid-path), as the [`human-initiated` recipe](/chernabog/recipes/human-initiated/) composes them. `Hybrid.itemFor` takes an `issue-<n>` key, whatever its labels, as a [manual flow](#manual-flows)'s `item`; `Hybrid.claim`, `workWithPerson`, `openPullRequest` and `handOff` are its steps, between `Implement`'s `prepareWorktree`, `localGate`, `push` and `waitForCi`; `Hybrid.personSession(issue)` names the person's session, for `localGate(worktree, { session })` and `waitForCi` to send fixes back to.
- `Review.reviewRequests` lists the open pull requests that ask this persona for a review, each with how many reviews it has posted; `Review.reviewItem(pull, key)` makes one a work item. `Review.latestOwnReview(pr)` finds this persona's latest review to resume with `Review.recheck`.
- `Review.authoredByMe`, `Review.decisiveReviews(pr)` and `Review.addressItem` find the reviews that ask for changes on this persona's pull requests; `Review.changesAsked`, `authorSession`, `prepareAuthorWorktree`, `checkChanged` and `askAgain` are `address-review`'s steps around `Implement.considerFindings` and `addressFindings`. `Review.ownedByARun(pull)` says whether another flow's run owns a pull request.
- The SDK has no whole workflows and no triggers of the review loop: those are written out in each recipe, where a repo can read and change them.
- `PullRequest.shipping(pr)` says, once per run, whether chernabog may merge the pull request: whether it carries `auto:ship` (`PullRequest.ships`). The recipes merge only then, with `PullRequest.merge`, and leave any other for a person; `PullRequest.mergeOrLeave(pr)` does the same in one block. `PullRequest.handToPerson(pr, reason)` labels it `auto:needs-human` and ends the run.
- `Claims` holds a run's [claims](/chernabog/flows/sdk/#claims): `Claims.acquire(item)`, `holder(item)` and `release(item)` on `Claims.issue(n)` or `Claims.pullRequest(n)`, and `Claims.releasing(item)(effect)`, which lets a claim go however `effect` ends. `Implement.claim` and `Hybrid.claim` acquire the issue's, and hold it as a marker, so it goes however the run ends; `releasing` lets it go sooner.
- `Markers` defines, holds and drops [markers](/chernabog/flows/sdk/#markers): what a run put on an item, which the daemon releases however the run ends.
- `PullRequest.owning(pr)(effect)` holds the pull request's claim while `effect` runs, so the standalone `review`, `re-review` and `address-review` flows leave it alone. A pull request another run owns is skipped.

See [the label contract](/chernabog/flows/sdk/#the-label-contract) for what each ending must leave.

| `Implement.`         | `Review.`                    | `PullRequest.`, `Issue.` |
| -------------------- | ---------------------------- | ------------------------ |
| `issueItem`, `triggerFor`, `queued`, `queuedBy`, `gate` | `reviewRequests`, `reviewItem`, `pullRequestOf` | `PullRequest.requestReview`, `ships`, `shipping` |
| `issueOf`, `claim`   | `round`, `recheck`, `doneReviewing`, `latestOwnReview` | `PullRequest.merge`, `mergeOrLeave`, `handToPerson` |
| `prepareWorktree`    | `authoredByMe`, `decisiveReviews`, `addressItem`, `addressItemOf` | `PullRequest.comment`, `Issue.comment` |
| `implementWithAgent`, `askForClarification` | `changesAsked`, `authorSession`, `prepareAuthorWorktree` | `PullRequest.own`, `release`, `owning` |
| `localGate`, `push`  | `checkChanged`, `askAgain`, `ownedByARun` |                          |
| `openPullRequest`, `waitForCi` |                    |                          |
| `considerFindings`, `addressFindings` |             |                          |
| `handOff`, `handToHuman`, `endForPerson` |          |                          |

A step that loops, `localGate` and `waitForCi`, names its activities by round. A flow that calls one twice in a run gives the second call an id, `localGate(worktree, { id: "review-1" })`, so its activities are `local-gate-1#review-1` and so on. [Composing a flow](/chernabog/flows/composing/) walks through the default `implement` flow and a review flow of your own.

### Considering findings

A flow that answers its own reviews resumes sessions instead of starting new ones:

- `Review.recheck(pr, review)` resumes the reviewer's session from `review` with the change since the head it saw, and posts the next review. It returns the same verdict as `Review.round`, plus `findings`: each earlier finding, with whether it was `remediated`. It counts as the next round, so `review-2` after `review-1`. The default `re-review` flow is built on it.
- `Implement.considerFindings(pr, review, session)` resumes the author's session with the review and returns `{ status: "address" | "decline", reasons }`. It changes nothing.
- `Implement.addressFindings(pr, review, session)` resumes the same session to make the changes and commit, and returns the answer `fixWithAgent` does. The flow then runs `localGate`, `push` and `waitForCi` as usual. The default `address-review` flow is built on these two.
- `PullRequest.comment(pr, body)` and `Issue.comment(issue, body)` post a comment and do nothing else. A run posts each distinct comment on an item once.

On a pull request whose session marker has `withPerson`, as `Hybrid.handOff` leaves, `address-review` passes `withPerson` on, so `considerFindings`, `addressFindings` and its local gate and CI fixes reopen the session in front of the person.

Each of these has its own prompt, `recheck`, `consider` and `address`, and `Hybrid.workWithPerson` has one, `human-initiated`. The SDK carries a default for each, and a repo overrides one with `.chernabog/prompts/<name>.md`.

### Merging

`PullRequest.merge(pr, { method })`, with `method` one of `merge`, `squash` or `rebase`, merges the pull request when that is safe, and decides that itself when it runs:

- its required checks are green on the current head;
- the latest review approved that very head, or the head has only merged the base in since (`PullRequest.onlyMergedBase`: every commit on its first parents back to the reviewed one is a two-parent merge of a commit on the base branch, with exactly the tree a clean automatic merge gives, so a merge where someone resolved a conflict or added edits still needs a review);
- it touches no `humanOnlyPaths`;
- GitHub's rules for the repo allow it. The merge is of exactly the head it checked, so GitHub refuses it if the head moves in between.

Otherwise it fails with `MergeRefused`, giving the reason, or `PullRequestClosed` when the pull request was closed without merging, and merges nothing. A pull request merged already, as by a rerun, counts as merged. Nothing merges unless a flow calls it. The recipes call it only when `PullRequest.shipping` says the pull request is labelled `auto:ship`.

## Dependencies

`.chernabog/` is a package of its own, the same in every repo whatever its language. Anything a flow or step imports beyond `@chernabog/sdk` and `effect` goes in its `dependencies`, with the lockfile committed. The daemon installs them into each base-branch snapshot with the binary itself, as `bun install --production --frozen-lockfile --ignore-scripts`, so the machine needs no Node or package manager. See [Versions](/chernabog/operate/versions/#pins) for the two pinned packages.
