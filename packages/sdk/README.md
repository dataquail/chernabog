# @chernabog/sdk

The blocks Chernabog flows and steps are written from (`Implement`, `Review`, `Plan`, `Hybrid`, `Stack`, `PullRequest`, prompts), over [`@chernabog/core`](https://www.npmjs.com/package/@chernabog/core), which it re-exports, so a flow imports everything from this one package.

A repo lists it in `.chernabog/package.json`'s `dependencies`, at the version it chooses, and each snapshot of the repo's base branch installs it: two repos on different versions run side by side in one daemon. The `chernabog` binary supplies its own copies of `@chernabog/core` and `effect` at runtime, and runs this package when its peer range on `@chernabog/core` includes a core the binary provides. `chernabog recipes upgrade` moves a repo to the version released with its binary.

## Flows

```ts
import { Claims, defineFlow, Implement, step } from "@chernabog/sdk";
import { Effect, Schema } from "effect";

export default defineFlow({
  trigger: Implement.triggerFor("auto:eligible"), // the work items to act on
  gate: Implement.gate, // checked before each run starts; fail with Skip to hold it back
  concurrency: 1,
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = yield* Implement.issueOf(item);

      // However the run ends, its claim on the issue goes.
      return yield* Effect.gen(function* () {
        const { branch } = yield* Implement.claim(issue);
        const checked = yield* step(
          "check-scope",
          { issue },
          { output: Schema.Struct({ ok: Schema.Boolean }) },
        );
        // ...
      }).pipe(Claims.releasing(Claims.issue(issue)));
    }),
});
```

| Helper                                  | What it does                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `activity(name, effect, { success })`   | One durable step. It runs once and its result is saved; a replay returns the saved result. Names are unique within a run, so a step in a loop carries its round: `fix-ci-2`.                                                         |
| `step(name, input, { output })`         | Runs `.chernabog/stages/<name>` in its own process, as an activity.                                                                                                                                                                  |
| `sleep(name, duration)`                 | A durable pause that survives restarts.                                                                                                                                                                                              |
| `awaitSignal(signals, { id, timeout })` | Waits for one of the signals (which the trigger reports in `WorkItem.signals`) or the timeout, whichever comes first, and says which. A trigger can report an item with `wakeOnly` to wake a waiting run without starting a new one. |
| `renderPrompt(name, values)`            | Fills `.chernabog/prompts/<name>.md`, or, for a flow imported from a recipe package (`FlowPackage`), the package's when the repo has none.                                                                                           |
| `Skip`, `NeedsHuman`                    | End a run cleanly, or hand its item to a person.                                                                                                                                                                                     |

`Implement`, `Review` and `PullRequest` hold the building blocks of the review loop, each an activity a flow can reorder, leave out or wrap. `Hybrid` holds the blocks of the hybrid path, where a person works on an issue with the agent in an interactive session. `Plan` holds the blocks of the plan recipe, which turns a spec issue into an epic of sub-issues once a person approves the agent's plan. `Stack` brings a layer of a stack of pull requests up to date with its base by merging, including once the layer below was squash-merged. Chernabog's [recipes](https://dataquail.github.io/chernabog/recipes/) are complete flows written out from these blocks, which a repo bakes into its own `.chernabog/flows/`; they are published as [`@chernabog/recipes`](https://www.npmjs.com/package/@chernabog/recipes), whose source is [`packages/recipes/`](https://github.com/dataquail/chernabog/tree/main/packages/recipes).

A flow can also give `item: (key) => Effect<Option<WorkItem>>`, the work item for a key a person names that the trigger doesn't report, as `Hybrid.itemFor` finds the issue `chernabog start` names.

Side effects belong inside activities or steps, never in the workflow body, which runs again on every replay.

## Steps

```ts
// .chernabog/stages/find-work.ts
import { defineStage, GitHub, Skip } from "@chernabog/sdk";
import { Effect, Schema } from "effect";

export default defineStage({
  name: "find-work",
  input: Schema.Struct({}),
  output: Schema.Struct({ issue: Schema.Number }),
  run: () =>
    Effect.gen(function* () {
      const issue = yield* (yield* GitHub).oldestQueued;
      if (issue === undefined) return yield* new Skip({ reason: "nothing queued" });
      return { issue };
    }),
});
```

## Services

The services are core's: each is a port the binary provides.

| Service           | Covers                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `Repo`            | The repo's merged settings: slug, base branch, labels, limits, gates, notes                          |
| `Run`             | The run: flow, run id and work item                                                                  |
| `GitHub`          | Queued issues, claims, labels, comments, sub-issues and blockers, branches, pull requests, CI state  |
| `Agent`           | Starting and resuming agent sessions through an adapter; `withPerson` opens one in front of a person |
| `Git`, `Worktree` | Commits ahead, changed files, pushes; one worktree per branch                                        |
| `Usage`           | The account check and the usage gate                                                                 |
| `RunLog`          | The run's log                                                                                        |

Each service is a layer, so a team can replace one with its own implementation, and tests can use fakes.
