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
| `schedule`    | optional cron; `flows.<flow>.schedule` and `local.yaml`'s `schedule` override it |
| `labels`      | optional; labels of the flow's own, such as `{ name: "auto:ship" }`, which `chernabog labels` creates |
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
| `activity(name, effect, { success })`   | One durable step; runs once, and a replay returns the saved result       |
| `step(name, input, { output })`         | Runs [`.chernabog/stages/<name>`](/chernabog/flows/steps/) in its own process, as an activity |
| `sleep(name, duration)`                 | A durable pause that survives restarts                                    |
| `awaitSignal(signals, { id, timeout })` | Waits for one of the signals or the timeout, and says which              |
| `renderPrompt(name, values)`            | Fills `.chernabog/prompts/<name>.md`                                     |
| `Skip`, `NeedsHuman`                    | End a run cleanly, or hand its item to a person                          |

Activity names are unique within a run, so one in a loop carries its round: `fix-ci-2`.

**Signals.** A trigger reports signals in `WorkItem.signals`; a waiting run's `awaitSignal` wakes on them. Report an item with `wakeOnly` to wake a waiting run without starting a new one.

## Building blocks

`Implement` and `Review` hold the blocks of [the default flows](/chernabog/work/flows/), each an activity a flow can reorder, leave out or wrap. `Review.round` reviews and posts, with the adapter of an optional `{ role }` from [`flows.<flow>.agents`](/chernabog/reference/configuration/#agents-by-role); `Review.labelVerdict` moves the labels after it, and `Review.reviewRound` does both in one step. `Implement.handOff(issue, pr, outcome, { needsReview: false })` hands off without starting the `review` flow. `Implement.triggerFor(label)` queues issues by a label of the flow's own, paired with `claim(issue, { label })`; `Implement.trigger` is `triggerFor` with `auto:eligible`. `PullRequest.owning(pr)(effect)` marks the pull request as the run's while `effect` runs, so the standalone `review` and `fix` flows leave it alone. See [the label contract](/chernabog/flows/sdk/#the-label-contract) for what each ending must leave.

| `Implement.`         | `Review.`                    | `PullRequest.`, `Issue.` |
| -------------------- | ---------------------------- | ------------------------ |
| `trigger`, `triggerFor`, `gate` | `trigger`, `workflow` | `PullRequest.comment`, `Issue.comment` |
| `issueOf`, `claim`   | `round`, `labelVerdict`      | `PullRequest.own`, `release`, `owning` |
| `prepareWorktree`    | `recheck`                    |                          |
| `implementWithAgent`, `askForClarification` | `reviewRound`, `cleanUp` |  |
| `localGate`, `push`  | `fixTrigger`, `fixWorkflow`  |                          |
| `openPullRequest`, `waitForCi` |                    |                          |
| `considerFindings`, `addressFindings` |             |                          |
| `handOff`, `handToHuman`, `endForPerson` |          |                          |

### Considering findings

A flow that answers its own reviews resumes sessions instead of starting new ones:

- `Review.recheck(pr, review)` resumes the reviewer's session from `review` with the change since the head it saw, and posts the next review. It returns the same verdict as `Review.round`, plus `findings`: each earlier finding, with whether it was `remediated`. It counts as the next round, so `review-2` after `review-1`, and `Review.labelVerdict` takes it like any other review.
- `Implement.considerFindings(pr, review, session)` resumes the author's session with the review and returns `{ status: "address" | "decline", reasons }`. It changes nothing.
- `Implement.addressFindings(pr, review, session)` resumes the same session to make the changes and commit, and returns the answer `fixWithAgent` does. The flow then runs `localGate`, `push` and `waitForCi` as usual.
- `PullRequest.comment(pr, body)` and `Issue.comment(issue, body)` post a comment and do nothing else. A run posts each distinct comment on an item once.

Each of these has its own prompt, `recheck`, `consider` and `address`. The SDK carries a default for each, and a repo overrides one with `.chernabog/prompts/<name>.md`.

## Dependencies

`.chernabog/` is a package of its own, the same in every repo whatever its language. Anything a flow or step imports beyond `@chernabog/sdk` and `effect` goes in its `dependencies`, with the lockfile committed. The daemon installs them into each base-branch snapshot with the binary itself, as `bun install --production --frozen-lockfile --ignore-scripts`, so the machine needs no Node or package manager. See [Versions](/chernabog/operate/versions/#pins) for the two pinned packages.
