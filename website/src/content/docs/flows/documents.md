---
title: Flow documents
description: Write a flow as YAML from the SDK's blocks, and compile it to an ordinary flow file. Experimental.
---

A flow document is a flow written as data. Each step names a block, every value it takes names the step that value came from, and it branches only on outcomes the block declares. There are no expressions. It compiles to an ordinary flow file, so the engine, `chernabog rehearse` and your editor treat the result like any other flow.

Flow documents are **experimental**. The format and its blocks may change. So far, blocks cover the `implement`, `review`, `re-review`, `address-review`, `resolve-conflicts`, `post-merge`, `human-initiated`, `plan` and `epic` recipes.

## A document

A document lives at `.chernabog/documents/<flow>.yaml`:

```yaml
flow: review
subject: pull-request
concurrency: 1
trigger:
  - use: review.requested
  - use: review.waitingElsewhere
steps:
  - id: review
    use: review.round
    in: { pr: trigger.pr }
    with: { round: 1, role: reviewer }
    on:
      approve:
        as: verdict
        steps:
          - id: land
            use: pr.land
            in: { pr: trigger.pr, approved: verdict.approved }
            with: { method: squash }
          - end: done
            summary: land
      changes:
        steps:
          - end: done
            summary: review.changesAsked
```

- `review.requested` finds the pull requests that ask this persona for a review it hasn't given yet. `review.waitingElsewhere` starts no review: its pull requests wait on a reviewer no persona on this machine acts as, and it lists them in `chernabog status` as waiting there. A flow can leave it out.
- `pr.land` merges only a pull request labelled `auto:ship`, and merges nothing otherwise. A flow that must never merge leaves `pr.land` out rather than relying on the label.
- `in` wires an input to an earlier step's output. `with` gives it a fixed value. The listing says which each input takes; a few, such as `review.round`'s `round`, take either.
- `on` says what happens at an outcome the block declares. A block can require you to route an outcome.
- `end` finishes the run or lane, as `done` or `needs-human`. `end: needs-human` stops the run with its `reason`, but labels and comments on nothing, so put a block that tells a person in front of it. On a pull request, `pr.handToPerson` labels it `auto:needs-human`, comments why, and gives the reason to end with:

  ```yaml
  - id: handed
    use: pr.handToPerson
    in: { pr: trigger.pr, reason: open.reason }
  - end: needs-human
    reason: handed
  ```

  A way that ends `needs-human` owes nothing a block [leaves to do](#order). So a flow that gives every pull request to a person, rather than to a reviewer, follows `pr.open` with `pr.handToPerson` and `end: needs-human` in place of `issue.handOff`. Each of its runs then ends needing a person, by design.

- Using a block adds what it needs to the flow: its settings, labels, doctor checks, and the trigger entries that wake runs parked in it.
- `failureContext` says what a failure going to a person can point them at, when the subject keeps something for it: on `issue`, the pull request a run opened, as `pr: [opened.number]`, the outputs that set it. `chernabog recipes blocks` lists what each subject keeps, after `failureContext keeps`.

## Where the work comes from

`trigger` lists the sources a flow's work comes from, each with what it takes under `with`. `issues.queued` takes `labels`, which are what a label means, not a label's name: `eligible`, the normal queue, and `ship`, whose issues' pull requests merge once approved. They name the repo's labels, `auto:eligible` and `auto:ship` by default. To queue a flow's issues by a label of its own, such as `docs`, keep `labels: [eligible]` and set that flow's `eligible` label in `.chernabog/config.yaml`:

```yaml
flows:
  docs-only:
    settings:
      labels: { eligible: docs }
```

The flow's blocks use that name for it too, so `issue.claim` takes `docs` off the issue it claims, and `chernabog labels` creates it. Other flows keep `auto:eligible`.

## Subjects

A flow's `subject` is what each run works on. It decides what `trigger` gives the steps, and what happens around them however the run ends. `chernabog recipes blocks` lists each subject with the fields its trigger gives.

- `issue`: `trigger.issue` and `trigger.queued`. A failure going to a person comments on the issue, and a claim on it goes when the run ends. A person can [start](#a-flow-a-person-starts) a flow on it.
- `pull-request`: `trigger.pr`. A failure going to a person labels the pull request `auto:needs-human` and comments why.
- `changes-asked`: a review that asks for changes on a pull request this persona wrote, found by the `review.changesRequested` source. `trigger.pr`, `trigger.branch` and `trigger.base` are the pull request's, `trigger.reviewer` is who asked for the changes, and `trigger.reviewedSha` is the commit they reviewed. The run owns the pull request from its first step to its end, so `resolve-conflicts` doesn't merge into the branch under it, and a pull request another run owns is skipped. A failure going to a person labels it `auto:needs-human` and comments why, as on `pull-request`.
- `conflict`: a pull request this persona wrote that GitHub says conflicts with its base, found by the `pr.conflicting` source. `trigger.pr`, `trigger.branch` and `trigger.base` are the pull request's; on a layer of a stack, `trigger.base` is the layer below's branch. The run owns the pull request from its first step to its end, as on `changes-asked`, and a failure going to a person labels it `auto:needs-human` and comments why.
- `merged`: a pull request this persona wrote that merged into the flow's base branch in the last day, found by the `pr.mergedRecently` source. `trigger.pr`, `trigger.url` and `trigger.title` are the pull request's, `trigger.sha` is its merge commit, `trigger.base` the branch it merged into, and `trigger.issue` the issue it closes, if it names one. A run owns and claims nothing. A failure going to a person labels the merged pull request `auto:needs-human` and comments why, though the `merged.*` blocks send none there: a run ends needing a person, or failed, as the recipe's does.
- `epic`: `trigger.epic`, an issue labelled `auto:epic`.
- `spec`: an issue to plan, found by the `plan.queued` source: `trigger.issue` and `trigger.queued`, as on `issue`. A failure going to a person removes the plan's checkout, labels the spec `auto:needs-human` and comments why, and its claim goes when the run ends; a run parked waiting on its plan keeps it.

On `changes-asked`, the `author.*` blocks answer the review in the session that wrote the code. `author.session` finds it from the session marker the run that opened the pull request left: on a layer of an epic's stack, that is the task's own session, and on one a person worked on with the agent, theirs, reopened in front of them. `review.askAgain` asks `trigger.reviewer` to review again, not a reviewer from the pool:

```yaml
- id: again
  use: review.askAgain
  in:
    pr: trigger.pr
    review: asked
    reviewer: trigger.reviewer
    summary: addressed.summary
    pushed: pushed.pushed
- end: done
  summary: again
```

On `conflict`, `conflict.resolve` merges `trigger.base` into the branch, never by a rebase, and has an agent resolve the conflicts and commit the merge in a session of the run's own. A layer of a stack whose layer below squash- or rebase-merged has that layer recorded as already here first, inside the block, so the merge doesn't bring back what the base has since moved or deleted. Its `session` goes to `conflict.localGate` and `conflict.waitForCi`, so failures go back to the session that resolved the conflict, and it can come to `needs-human` when only a person can settle the conflict:

```yaml
- id: resolved
  use: conflict.resolve
  in: { pr: trigger.pr, branch: trigger.branch, base: trigger.base, worktree: worktree }
  on:
    needs-human:
      as: stuck
      steps:
        - id: handed
          use: pr.handToPerson
          in: { pr: trigger.pr, reason: stuck.reason }
        - end: needs-human
          reason: handed
```

`conflict.askApproverAgain` asks the reviewer whose latest decisive review approved the pull request to review again, since they approved the code before the merge, and asks no one otherwise.

On `merged`, `merged.markWatched` leaves the marker `pr.mergedRecently` looks for, so each merge is watched once. `merged.awaitCi` waits for push CI on the merge commit and comes to `none`, `green` or `red`, each of which a document must route; CI still pending after `ciTimeout` ends the run needing a person. `merged.redBefore` comes to `already-red` when CI was red before the merge too. On red, `merged.fileFollowUp` files a follow-up for `implement`, or for a person when the merged pull request was a follow-up's own fix, as `merged.closesFollowUp` finds:

```yaml
- id: ci
  use: merged.awaitCi
  in: { pr: trigger.pr, sha: trigger.sha, base: trigger.base }
  on:
    none:
      as: quiet
      steps:
        - end: done
          summary: quiet.summary
    green:
      as: passed
      steps:
        - end: done
          summary: passed.summary
    red:
      as: red
      steps:
        - id: before
          use: merged.redBefore
          in: { pr: trigger.pr, sha: trigger.sha }
          on:
            already-red:
              as: already
              steps:
                - end: done
                  summary: already.summary
        - id: closes
          use: merged.closesFollowUp
          in: { issue: trigger.issue }
        - id: failed
          use: merged.failureDetails
          in: { ci: red }
        - id: filed
          use: merged.fileFollowUp
          in:
            pr: trigger.pr
            url: trigger.url
            title: trigger.title
            sha: trigger.sha
            base: trigger.base
            ci: red
            details: failed.details
            fixed: closes.fixed
        - id: linked
          use: merged.linkFollowUp
          in:
            pr: trigger.pr
            sha: trigger.sha
            base: trigger.base
            followUp: filed
            fixed: closes.fixed
        - end: done
          summary: linked
```

On `spec`, the `plan.*` blocks plan the work: the `plan` recipe composes them. `plan.draft` has the agent propose the tasks the spec splits into, in a read-only checkout, and checks the plan in code. A plan that fails its checks goes back to the agent with what's wrong, in steps named `fix-plan-<round>-<attempt>`, up to `planRounds` times, and then to a person, all inside the block. It comes to `needs-clarification` when the agent answers with questions. `plan.propose` posts the plan and `plan.awaitAnswer` parks until a person answers. It comes to `approved` or `changes`, each of which a document must route, and nobody answering within `within` goes to a person. Only `approved` gives the `PlanApproved` that `plan.create` takes. `plan.changesAsked` gives the next round what to change, through the `plan.changes` loop state:

```yaml
- id: rounds
  repeat:
    state: { changes: plan.changes }
    steps:
      - id: drafted
        use: plan.draft
        in: { issue: trigger.issue, round: round, changes: state.changes }
        on:
          needs-clarification:
            as: questions
            steps:
              - id: cleared
                use: plan.doneDrafting
                in: { issue: trigger.issue }
              - id: posted
                use: plan.askClarification
                in: { issue: trigger.issue, draft: questions }
              - end: needs-human
                reason: posted
      - id: proposed
        use: plan.propose
        in: { issue: trigger.issue, round: round, draft: drafted.draft }
      - id: answer
        use: plan.awaitAnswer
        in: { round: round }
        with: { within: 14 days }
        on:
          approved:
            as: approval
            steps:
              - id: created
                use: plan.create
                in: { issue: trigger.issue, plan: proposed.plan, approved: approval.approved }
              - id: epic
                use: plan.becomeEpic
                in: { issue: trigger.issue, plan: proposed.plan, created: created.created }
              - id: cleaned
                use: plan.doneDrafting
                in: { issue: trigger.issue }
              - end: done
                summary: epic
          changes:
            steps:
              - id: asked
                use: plan.changesAsked
                in: { issue: trigger.issue, round: round }
              - next: { changes: asked.changes }
```

`plan.create`, `plan.becomeEpic`, `plan.doneDrafting` and `plan.askClarification` [run last](#blocks-that-run-last), so they take no `round` in the repeat. `plan.draft` leaves the checkout to remove, so a way that ends `done` must go through `plan.doneDrafting`. The run claims the spec with `issue.claim`, whose `StepFailed` the recipe has fail the run, as `failure: { StepFailed: fail }` does.

## A flow a person starts

A flow that a person starts by naming an issue, with `chernabog start <issue>` (or `chernabog run <flow> --item issue-<n>`), says `start: true` in place of `trigger`. Nothing finds its work on a schedule, so it has no sources, and the daemon never ticks it: it's a [manual flow](/chernabog/flows/flows/#manual-flows). It takes the issue the person names whatever its labels, and each run is that person's, so it finds no work for several personas to share. It's the flow `chernabog start` runs, so a repo should have only one; `chernabog start` names them when it has several.

- Only a flow on `issue` can be started. `chernabog recipes blocks` says which subjects can.
- A document with both `start: true` and a trigger is refused, and so is one with neither.
- A block that parks until the flow's trigger wakes it, such as `pr.awaitReady` or `pr.land`, is refused, because nothing would wake it.

The `hybrid.*` blocks are the [hybrid path](/chernabog/work/flows/#the-hybrid-path), which the `human-initiated` recipe composes. `hybrid.claim` claims the issue for a person's run, and `hybrid.workWithPerson` opens the session with them that `chernabog open-pr` ends. A failure up to then fails the run, or ends it as it is, rather than going to a person, as the recipe's does. Override `worktree.prepare`'s `StepFailed` to `fail` for the same reason. A session the person closes fails the run and keeps the issue in progress for their next start. After the session, `hybrid.localGate` and `hybrid.waitForCi` send their fixes back to the person's session. `hybrid.push` pushes a change to `humanOnlyPaths` too, because the person watched it written. `hybrid.openPullRequest` labels the pull request `hybrid`, so a person merges it:

```yaml
flow: human-initiated
subject: issue
start: true
failureContext:
  pr: [opened.number]
steps:
  - id: claim
    use: hybrid.claim
    in: { issue: trigger.issue }
  - id: worktree
    use: worktree.prepare
    in: { branch: claim.branch, base: claim.base }
    failure: { StepFailed: fail }
  - id: session
    use: hybrid.workWithPerson
    in: { issue: trigger.issue, worktree: worktree, base: claim.base }
  - id: gate
    use: hybrid.localGate
    in: { issue: trigger.issue, worktree: worktree }
  - id: push
    use: hybrid.push
    in: { worktree: worktree, branch: claim.branch, base: claim.base, committed: session.committed }
  - id: opened
    use: hybrid.openPullRequest
    in: { issue: trigger.issue, finished: session.finished, base: claim.base, pushed: push.pushed }
  - id: ci
    use: hybrid.waitForCi
    in:
      issue: trigger.issue
      pr: opened.number
      worktree: worktree
      branch: claim.branch
      base: claim.base
  - id: handed
    use: hybrid.handOff
    in: { issue: trigger.issue, pr: opened, finished: session.finished }
  - end: done
    summary: handed
```

## Your own steps

When no block does what your team needs, a document can run a step of your own from `.chernabog/stages/`. Name the stage with `stage:` where a block's step has `use:`:

```yaml
steps:
  - id: found
    stage: find-work
    in: { issue: trigger.issue }
    with: { label: auto:eligible }
    failure: { Skip: skip, StepFailed: person }
  - id: claim
    use: issue.claim
    in: { issue: found.issue }
```

`.chernabog/stages/find-work.ts` is an Effect stage, as [Steps](/chernabog/flows/steps/) describes:

```ts
import { defineStage } from "@chernabog/sdk";
import { Effect, Schema } from "effect";

const Output = Schema.Struct({ issue: Schema.Number.pipe(Schema.brand("IssueNumber")) });

export default defineStage({
  name: "find-work",
  input: Schema.Struct({ issue: Schema.Number, label: Schema.String }),
  output: Output,
  run: (input) => Effect.succeed(Schema.decodeSync(Output)({ issue: input.issue })),
});
```

- `in` and `with` work as they do for a block: `in` wires an input to an earlier step's output, and `with` gives it a fixed value. Every input of a stage takes either.
- The stage's `input` and `output` schemas type its wires, both ways. The generated flow imports the stage, so a wire of the wrong type into it or out of it is reported at its line in the document, as a block's is. To wire a stage's output into an input that takes an `IssueNumber`, a `PullRequestNumber` or another of the blocks' types, brand the output field with that name, as `find-work` does.
- A stage has no table of failures, so `failure` must say what each of its two failures means. `Skip` is a stage that exits 78, and `StepFailed` is any other failure. Each takes `person`, `told`, `skip` or `fail`, as a block's do. A document that leaves one out is refused.
- A stage comes to no outcomes, so it has no `on`. To branch on what it found, give it a boolean output and put `if` on a later step.
- In a `repeat`, a stage takes `in: { round: round }`, and in a lane, `in: { lane: <item>.lane }`, as blocks do. These name its step in each round or lane and aren't passed to its input.
- Only an Effect stage can run in a document. A shell stage's output has no types to check its wires by, so a document that runs one is refused. Wrap it in an Effect stage.
- A stage counts as neither waiting nor changing anything, so a round of a `repeat` needs a block that waits or changes something, as it would without the stage.

`chernabog recipes blocks` lists your Effect stages after the blocks, with what each takes and gives.

## What a document can use

```sh
chernabog recipes blocks              # everything: subjects, sources, loop states, blocks
chernabog recipes blocks gate.local   # one block, or one of your stages
chernabog recipes blocks --json       # the same, for an agent
```

Each block says what it does, what each input takes, what it gives, the outcomes it can come to, and the order it runs in. The list comes from the `@chernabog/sdk` your repo pins, so it matches what your flows run with. It ends with your repo's Effect stages, each with what it takes and gives by its schemas. A stage that can't be loaded isn't listed.

A document that names a block, source, outcome or stage that isn't there is refused with the nearest names, at most three: a few edits away, such as `gate.local` for `gate.locl`, or the same name under another prefix, such as `gate.local` for `ci.local`.

## Compiling

```sh
chernabog recipes compile              # every document
chernabog recipes compile review       # one
chernabog recipes compile --check      # write nothing; fail if a flow file is out of date
chernabog recipes compile --json       # the same result, for an agent or a script
```

Compile with the `@chernabog/sdk` your repo pins, from `.chernabog/node_modules`. Change the document, not the generated file, and commit both. A document's `flow:` must match its filename, and a flow can have only one document, `.yaml` or `.yml`. With no documents, the command says so and exits 0, including with `--check`.

A problem is reported at its line in the document, and a document with problems leaves its flow file as it was. Its wires' types are checked only once it has no other problems, so fixing those can show more, and the command says so:

```
.chernabog/documents/implement.yaml:47:29: steps[2].in.worktree: Type 'BranchName' is not assignable to type 'WorktreePath'.
```

Checking each wire's type takes TypeScript, in `.chernabog/node_modules` or the repo's own `node_modules`. Without it, the command still catches unknown blocks, unavailable or missing inputs, unrouted outcomes and loops that can't end, and it tells you the types weren't checked. If TypeScript is installed but can't run the check, for example because it's too old for the generated `tsconfig.json`, that's reported as a problem with the document, and no flow file is written.

The daemon runs the flow file, not the document. `chernabog doctor` runs the same check as `--check` on `.chernabog/` as your default branch has it, and warns about each flow file that isn't what its document compiles to. That happens when someone edits the document without recompiling, or edits the flow file by hand:

```
! demo: .chernabog/flows/review.ts isn't what its flow document compiles to; the daemon runs the flow file
    fix: chernabog recipes compile review, or, if the flow file was edited by hand, move the edit into .chernabog/documents/ and compile it
```

A document with problems gets a warning of its own instead. It's only a warning, so doctor still passes, and a repo with no documents gets none.

## Loops and lanes

`repeat` runs its steps round after round, with explicit `state`, until a step ends the run. `next` goes to the next round, with what changed of the state. Every way through a round must end the run or go on with `next`, and every way to a `next` must wait or change something: a step that may not run, or lanes that may be none, doesn't count. Some round must end the loop. A block that runs steps in a round must take `round` from the loop, unless it [runs last](#blocks-that-run-last), and one in a lane must name its lane, since a run resumes by step names. Otherwise the document is refused.

`forEach` runs its steps once per item, as lanes beside each other. Each lane ends for itself. Blocks that run in a lane must be wired to its `lane`, because a run resumes by its step names.

`if` runs a step only when a boolean output is true. The step's output is then optional, and `first` joins it with what stands in for it. `first: [landed, carried]` is the first of those that ran.

### Blocks that run last

A block whose listing says `runs last` runs only on a run's way out, such as `plan.create`, which makes a plan's issues once a person approves it. It runs once, so in a `repeat` it takes no `round`, and its step names stay the same as its recipe's. The check holds a document to that: a way past it that goes on with `next` is refused, in the branches after it as well as in the steps that follow it. That holds when it sits in a branch that doesn't end, too: the run goes on into the steps after the branch, still on its way out. A `repeat` after it is a loop of its own, and its `next` goes round that loop, so it is checked as any other. Beside others, in a `forEach`, it still names its lane.

## Order

Blocks declare the order they need, and the check walks every way through a document, down every branch:

- `runs before`: on a way with both, this block must come first. The local gate, if you use it, runs before the push.
- `needs first`: this block must come after another. A round of an epic needs the epic claimed.
- `leaves to do` and `does`: what a block leaves must be done on any way that finishes `done`. A pull request that opens must be handed off. A way that ends `needs-human` is excused.

In a `repeat`, the check follows each `next` into the round after it, so these rules hold across rounds. What a round leaves to do is carried into the next one: a round that opens a pull request and goes on with `next` still needs a later round to hand it off before it ends `done`. `needs first` holds across the whole run, so a block that needs another is satisfied by an earlier round. `runs before` holds within a round, since each round starts over.

## What the blocks can't do yet

- Open a pull request as a draft. `pr.open` opens it ready for review; a document can't ask for a draft.
- Give a pull request to a person as a success. `pr.handToPerson` labels it `auto:needs-human` and the run ends `needs-human`, even when what the person is asked to do is merge an approved pull request.

Work no block covers can run as [your own step](#your-own-steps).

## What the checks don't catch

The checks make sure a flow is wired and ordered correctly, not that it does what your team wants. Removing the local gate or CI is allowed, because those are a team's choices. So is a branch that does nothing useful. For example, a review's `approve` that never lands still passes. [Rehearse](/chernabog/flows/rehearsing/) a flow before you rely on it.
