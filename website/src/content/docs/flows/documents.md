---
title: Flow documents
description: Write a flow as YAML from the SDK's blocks, and compile it to an ordinary flow file. Experimental.
---

A flow document is a flow written as data. Each step names a block, every value it takes names the step that value came from, and it branches only on outcomes the block declares. There are no expressions. It compiles to an ordinary flow file, so the engine, `chernabog rehearse` and your editor treat the result like any other flow.

Flow documents are **experimental**. The format and its blocks may change. So far, blocks cover the `implement`, `review` and `epic` recipes.

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

- `in` wires an input to an earlier step's output. `with` gives it a fixed value. The listing says which each input takes; a few, such as `review.round`'s `round`, take either.
- `on` says what happens at an outcome the block declares. A block can require you to route an outcome.
- `end` finishes the run or lane, as `done` or `needs-human`.
- Using a block adds what it needs to the flow: its settings, labels, doctor checks, and the trigger entries that wake runs parked in it.

## What a document can use

```sh
chernabog recipes blocks              # everything: subjects, sources, loop states, blocks
chernabog recipes blocks gate.local   # one block
chernabog recipes blocks --json       # the same, for an agent
```

Each block says what it does, what each input takes, what it gives, the outcomes it can come to, and the order it runs in. The list comes from the `@chernabog/sdk` your repo pins, so it matches what your flows run with.

## Compiling

```sh
chernabog recipes compile              # every document
chernabog recipes compile review       # one
chernabog recipes compile --check      # write nothing; fail if a flow file is out of date
chernabog recipes compile --json       # the same result, for an agent or a script
```

Compile with the `@chernabog/sdk` your repo pins, from `.chernabog/node_modules`. Change the document, not the generated file, and commit both. A document's `flow:` must match its filename, and a flow can have only one document, `.yaml` or `.yml`. With no documents, the command says so and exits 0, including with `--check`.

A problem is reported at its line in the document, and a document with problems leaves its flow file as it was:

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

`repeat` runs its steps round after round, with explicit `state`, until a step ends the run. `next` goes to the next round, with what changed of the state. Every way through a round must end the run or go on with `next`, and every way to a `next` must wait or change something: a step that may not run, or lanes that may be none, doesn't count. Some round must end the loop. A block that runs steps in a round must take `round` from the loop, and one in a lane must name its lane, since a run resumes by step names. Otherwise the document is refused.

`forEach` runs its steps once per item, as lanes beside each other. Each lane ends for itself. Blocks that run in a lane must be wired to its `lane`, because a run resumes by its step names.

`if` runs a step only when a boolean output is true. The step's output is then optional, and `first` joins it with what stands in for it. `first: [landed, carried]` is the first of those that ran.

## Order

Blocks declare the order they need, and the check walks every way through a document, down every branch:

- `runs before`: on a way with both, this block must come first. The local gate, if you use it, runs before the push.
- `needs first`: this block must come after another. A round of an epic needs the epic claimed.
- `leaves to do` and `does`: what a block leaves must be done on any way that finishes `done`. A pull request that opens must be handed off. A way that ends `needs-human` is excused.

## What the checks don't catch

The checks make sure a flow is wired and ordered correctly, not that it does what your team wants. Removing the local gate or CI is allowed, because those are a team's choices. So is a branch that does nothing useful. For example, a review's `approve` that never lands still passes. [Rehearse](/chernabog/flows/rehearsing/) a flow before you rely on it.
