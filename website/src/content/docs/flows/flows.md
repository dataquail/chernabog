---
title: Writing flows
description: defineFlow, durable activities, and composing the SDK's building blocks.
---

A flow is a TypeScript module in `.chernabog/flows/` whose default export is `defineFlow`:

| Field         | Is                                                                     |
| ------------- | ---------------------------------------------------------------------- |
| `trigger`     | an Effect returning the work items in the state the flow acts on       |
| `gate`        | optional; checked before each run starts — fail with `Skip` to hold it back |
| `concurrency` | runs of this flow at once                                              |
| `schedule`    | optional cron; `flows.<flow>.schedule` and the `schedule` on the repo's entry in machine config override it |
| `labels`      | optional; labels of the flow's own, such as `{ name: "auto:docs" }`, which `chernabog labels` creates |
| `ownWork`     | optional; `true` when the trigger finds only the work of the persona it runs as, as `review`'s does by its review requests, so the daemon doesn't warn that several personas each take any of it |
| `item`        | optional; `(key) => Effect<Option<WorkItem>>`: the work item for a key a person names that the trigger doesn't report, as `Hybrid.itemFor` finds the issue `chernabog start` names. `run --item <key>` and the daemon use it |
| `workflow`    | `(item) => Effect`: the durable work for one item                      |

Each step in a workflow is an **activity** whose result is saved in SQLite, so after a crash or restart the run resumes after the last completed step.

```ts
import { defineFlow, Implement, step } from "@chernabog/sdk";
import { Effect, Schema } from "effect";

export default defineFlow({
  trigger: Implement.trigger,
  gate: Implement.gate,
  concurrency: 1,
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);
      const { branch } = yield* Implement.claim(issue);
      const checked = yield* step("check-scope", { issue }, { output: Schema.Struct({ ok: Schema.Boolean }) });
      // ...
    }),
});
```

:::caution[Replay]
The workflow body runs again on every replay. Side effects belong inside activities or steps, never in the body.
:::

## Helpers

| Helper                                  | Does                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `activity(name, effect, schema)`        | One durable step; runs once, and a replay returns the saved result       |
| `step(name, input, { output })`         | Runs [`.chernabog/stages/<name>`](/chernabog/flows/steps/) in its own process, as an activity |
| `sleep(name, duration)`                 | A durable pause that survives restarts                                    |
| `awaitSignal(signals, { id, timeout })` | Waits for one of the signals or the timeout, and says which              |
| `renderPrompt(name, values)`            | Fills `.chernabog/prompts/<name>.md`                                     |
| `Skip`, `NeedsHuman`                    | End a run cleanly, or hand its item to a person                          |

Activity names are unique within a run, so one in a loop carries its round: `fix-ci-2`.

**Signals.** A trigger reports signals in `WorkItem.signals`; a waiting run's `awaitSignal` wakes on them. Report an item with `wakeOnly` to wake a waiting run without starting a new one.

## Building blocks

`Implement`, `Review` and `PullRequest` hold the blocks of [the default flows](/chernabog/work/flows/), and `Hybrid` those of the hybrid path; each is an activity a flow can reorder, leave out or wrap.

- `Implement.trigger` queues issues labelled `auto:eligible`, then `auto:ship`; `Implement.queuedBy(item)` says which label queued one, for `claim`, `askForClarification` and `openPullRequest`. `Implement.triggerFor(label)` queues issues by a label of the flow's own, paired with `claim(issue, queuedBy(item))`.
- `Implement.handOff(issue, pr, outcome)` asks one reviewer from the pool with `PullRequest.requestReview`; `{ needsReview: false }` hands off without asking.
- `Review.round(pr, n, { role })` reviews in a fresh session, with the adapter of an optional role from [`flows.<flow>.agents`](/chernabog/reference/configuration/#agents-by-role), and posts a real GitHub review with a marker that records the reviewer and its session. It moves no labels, and leaves the review's checkout, `review-pr-<n>`, for `Review.doneReviewing(pr)` to remove.
- `Hybrid`'s blocks make [the hybrid path](/chernabog/work/flows/#the-hybrid-path), which no default flow provides: a repo writes its own `human-initiated` flow from them, as chernabog's [`.chernabog/flows/human-initiated.ts`](https://github.com/dataquail/chernabog/blob/main/.chernabog/flows/human-initiated.ts) does. `Hybrid.trigger` finds nothing and `Hybrid.itemFor` takes an `issue-<n>` key, whatever its labels; `Hybrid.claim`, `workWithPerson`, `openPullRequest` and `handOff` are its steps, between `Implement`'s `prepareWorktree`, `localGate`, `push` and `waitForCi`; `Hybrid.personSession(issue)` names the person's session, for `localGate(worktree, { session })` and `waitForCi` to send fixes back to.
- `Review.trigger` and `Review.workflow` make `review`; `Review.reReviewTrigger` and `Review.reReviewWorkflow` make `re-review`; `Review.addressTrigger` and `Review.addressWorkflow` make `address-review`.
- `PullRequest.mergeOrLeave(pr)` is the one merge on the automated path: it merges a pull request that `PullRequest.ships` (it carries `auto:ship`), and leaves any other for a person. `PullRequest.handToPerson(pr, reason)` labels it `auto:needs-human` and ends the run.
- `PullRequest.owning(pr)(effect)` marks the pull request as the run's while `effect` runs, so the standalone `review`, `re-review` and `address-review` flows leave it alone.

See [the label contract](/chernabog/flows/sdk/#the-label-contract) for what each ending must leave.

| `Implement.`         | `Review.`                    | `PullRequest.`, `Issue.` |
| -------------------- | ---------------------------- | ------------------------ |
| `trigger`, `triggerFor`, `queuedBy`, `gate` | `trigger`, `workflow` | `PullRequest.requestReview`, `ships` |
| `issueOf`, `claim`   | `reReviewTrigger`, `reReviewWorkflow` | `PullRequest.merge`, `mergeOrLeave`, `handToPerson` |
| `prepareWorktree`    | `round`, `recheck`           | `PullRequest.comment`, `Issue.comment` |
| `implementWithAgent`, `askForClarification` | `addressTrigger`, `addressWorkflow` | `PullRequest.own`, `release`, `owning` |
| `localGate`, `push`  |                              |                          |
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
- the latest review approved that very head, so nothing has been pushed since;
- it touches no `humanOnlyPaths`;
- GitHub's rules for the repo allow it. The merge is of exactly the reviewed head, so GitHub refuses it if the head moves in between.

Otherwise it fails with `NeedsHuman`, giving the reason, and merges nothing. Nothing merges unless a flow calls it. The default flows call it only through `PullRequest.mergeOrLeave`, and so only for a pull request labelled `auto:ship`.

## Dependencies

`.chernabog/` is a package of its own, the same in every repo whatever its language. Anything a flow or step imports beyond `@chernabog/sdk` and `effect` goes in its `dependencies`, with the lockfile committed. The daemon installs them into each base-branch snapshot with the binary itself, as `bun install --production --frozen-lockfile --ignore-scripts`, so the machine needs no Node or package manager. See [Versions](/chernabog/operate/versions/#pins) for the two pinned packages.
