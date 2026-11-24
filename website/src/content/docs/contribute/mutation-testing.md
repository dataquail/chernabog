---
title: Mutation testing
description: What chernabog's nightly mutation run covers, how to read a survivor issue, and how to kill a mutant with a test that means something.
---

Coverage says which lines a test runs, not whether any test would fail if those lines were wrong. Chernabog's mutation run makes small changes to its own code, called **mutants**: it flips a comparison, drops a condition, empties a block. Then it checks that some test fails for each one. A mutant no test notices **survives**, and marks a test that doesn't pin down the behaviour it covers.

The run is nightly, never on a pull request. For each module with survivors it files or rewrites one issue, **Surviving mutants in _module_**, and closes it once nothing survives. Survivors are work, not a red build.

## What's in scope

The domain and concurrency core, where correctness rests on small guards that have to be exactly right. Each module has a config in `stryker/` that names the files it mutates and the focused tests it runs against:

| module               | mutates                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `progress`           | the threads adapter's compare-and-set (`progress.ts`)                          |
| `phase`              | a phase and its data (`packages/core/src/phase.ts`)                            |
| `phase-announcer`    | the event a recorded phase sends (`phase-announcer.ts`)                        |
| `phases`             | park, reconcile and the transition catalogue (`packages/sdk/src/phases.ts`)    |
| `ledger`             | the ledger and its tamper check (`ledger.ts`, `ledger-check.ts`)               |
| `progress-anomalies` | listing anomalies (`progress-anomalies.ts`)                                    |
| `ci-wake`            | what a finished CI run wakes (`events.ts`, `ci-plan.domain-service.ts`)        |
| `claims`             | leases and claims (`packages/core/src/claims.ts`)                              |

Out of scope: the CLI, the dashboard, the website and `test/acceptance/`. A module's `testFiles` is an explicit list, never discovered, and never includes acceptance tests. They are slow, and an assertion like `waitFor(() => merges.length > 0)` passes whether or not a guard ran.

## Reading a survivor issue

The issue groups survivors by the function they're in, since one missing test often explains several. Each line is a mutant:

```
- `src/modules/runs/infrastructure/runtime/progress.ts:603` ConditionalExpression: `ref.status === 422 && …` → `true`
```

That is the file and line, Stryker's mutator, and the code before and after. **no coverage** means no test in the selection even runs that line. A last section, **Unverified timeouts**, lists mutants that are neither killed nor survived (see [below](#timeouts-on-static-mutants)).

## Reproducing one mutant

```sh
bun run mutation progress
```

runs one module (`bun run mutation` with no module lists them). Open `reports/mutation/progress/mutation.html` for the report: every mutant, its status, and the tests that covered it. A run is incremental, so a second one re-tests only what changed. Add `--force` for a cold run, or `--mutate 'path/to/file.ts:603-603'` to mutate only some lines.

**A run rewrites the tree in place.** Stryker edits the files it mutates while it runs, and restores them from `.stryker-tmp/` when it ends. Don't edit files, switch branches or run other tests until it finishes. If one is interrupted, check `git status` before going on.

For a tighter loop, apply the mutant by hand: edit the line into its mutated form, run the module's `testFiles` (from its config) with `bun test`, and see whether anything fails. Then put the line back. This is also how to check a new test: it must fail with the mutant applied and pass without it.

## Killing a mutant

A kill is a test that **fails on the mutated code** and **asserts on behaviour**: what a caller, a person or GitHub would see. Ask what goes wrong for someone if the mutant shipped, and write the test that shows it.

Reject a test that kills the mutant without saying anything:

- **It imports the constant it pins.** If `PHASE_EVENT` → `""` survives, `expect(sent.event).toBe(PHASE_EVENT)` still passes on the mutant. Name the value the outside world depends on, `"chernabog-phase"`, which a repo's workflow listens for. The same goes for `THREADS`: assert on `chernabog/threads/pr-73`, not `` `${THREADS}pr-73` ``.
- **It restates the code.** A test that recomputes the answer the way the implementation does, or mirrors its branches one for one, fails on any mutant but checks nothing a person asked for. It also breaks on every refactor.
- **It reaches into internals.** Spying on a private helper, or asserting how often a function ran, ties the test to this implementation, not to what it must do.
- **It only exists for the mutant.** If a reviewer can't say what behaviour the test protects without reading the survivor issue, it isn't one.

One test that covers a function's real cases often kills several mutants in its group at once. Prefer that to one test per line.

## Equivalent mutants

Some mutants change the code but nothing any caller can observe, such as `{ ...undefined }` against `{ ...{} }`, or a `Context.Reference` key that only has to be unique. These are **equivalent**. Mark one on the line before it, with the mutator and a one-line reason:

```ts
// Stryker disable next-line ArrowFunction: { ...undefined } and { ...{} } spread to the same object
```

Where a comment can't sit on its own line before the mutant (inside a call's arguments, or a method chain), wrap the statement in `// Stryker disable <mutator>: <reason>` and `// Stryker restore <mutator>`. Name only the mutator that is equivalent. A mark on a line that also has killed mutants of the same kind hides those too; leave such a survivor listed and say why in the review.

Equivalence is a claim about every caller, so it needs a reason a reviewer can check. "No test notices" is the definition of a survivor, not a reason. Text for a person that no test pins word for word (`message`, `reason`, `fix`, `title`) is already ignored by `tools/stryker/ignore-messages.mjs`.

## Timeouts on static mutants

A **static** mutant is in code that runs once, when a module loads: a constant, a schema, a regex. Stryker can't tell which tests reach it, so it runs the module's whole selection against it. Stryker counts a Timeout as a kill, assuming the mutant made a loop that never ends. On a static mutant under load, a slow test can time out instead, so the issue lists those as **unverified**, not killed. Run one again with a larger `timeoutMS` in the module's config; if it then survives, it is a survivor like any other.

A Timeout on a mutant that isn't static is a real kill.

## Further reading

- [The mutation baseline](https://github.com/dataquail/chernabog/blob/main/docs/testing/mutation-baseline.md): each module's first full run, what is ignored and why, and the gaps open at the time.
- [The spike](https://github.com/dataquail/chernabog/blob/main/docs/testing/mutation-spike.md): why StrykerJS and the bun runner, what a run costs, and how Timeouts mislead.
