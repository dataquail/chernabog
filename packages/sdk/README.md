# @chernabog/sdk

The services and helpers for writing Chernabog flows and steps. At runtime the `chernabog` binary supplies its own copy of this package and of `effect`, so a repo needs them only as devDependencies, for types.

## Flows

```ts
import { defineFlow, Implement, step } from "@chernabog/sdk";
import { Effect, Schema } from "effect";

export default defineFlow({
  trigger: Implement.triggerFor("auto:eligible"), // the work items to act on
  gate: Implement.gate, // checked before each run starts; fail with Skip to hold it back
  concurrency: 1,
  workflow: (item) =>
    Effect.gen(function* () {
      const issue = Implement.issueOf(item);
      const { branch } = yield* Implement.claim(issue);
      const checked = yield* step(
        "check-scope",
        { issue },
        { output: Schema.Struct({ ok: Schema.Boolean }) },
      );
      // ...
    }),
});
```

| Helper                                  | What it does                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `activity(name, effect, { success })`   | One durable step. It runs once and its result is saved; a replay returns the saved result. Names are unique within a run, so a step in a loop carries its round: `fix-ci-2`.                                                         |
| `step(name, input, { output })`         | Runs `.chernabog/stages/<name>` in its own process, as an activity.                                                                                                                                                                  |
| `sleep(name, duration)`                 | A durable pause that survives restarts.                                                                                                                                                                                              |
| `awaitSignal(signals, { id, timeout })` | Waits for one of the signals (which the trigger reports in `WorkItem.signals`) or the timeout, whichever comes first, and says which. A trigger can report an item with `wakeOnly` to wake a waiting run without starting a new one. |
| `renderPrompt(name, values)`            | Fills `.chernabog/prompts/<name>.md`.                                                                                                                                                                                                |
| `Skip`, `NeedsHuman`                    | End a run cleanly, or hand its item to a person.                                                                                                                                                                                     |

`Implement`, `Review` and `PullRequest` hold the building blocks of the review loop, each an activity a flow can reorder, leave out or wrap. `Hybrid` holds the blocks of the hybrid path, where a person works on an issue with the agent in an interactive session. Chernabog's [recipes](https://dataquail.github.io/chernabog/recipes/) are complete flows written out from these blocks, which a repo bakes into its own `.chernabog/flows/`; [`templates/recipes/flows/`](https://github.com/dataquail/chernabog/tree/main/templates/recipes/flows) holds their current versions.

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

| Service           | Covers                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `Repo`            | The repo's merged settings: slug, base branch, labels, limits, gates, notes                          |
| `Run`             | The run: flow, run id and work item                                                                  |
| `GitHub`          | Queued issues, claims, labels, comments, branches, pull requests, CI state                           |
| `Agent`           | Starting and resuming agent sessions through an adapter; `withPerson` opens one in front of a person |
| `Git`, `Worktree` | Commits ahead, changed files, pushes; one worktree per branch                                        |
| `Usage`           | The account check and the usage gate                                                                 |
| `RunLog`          | The run's log                                                                                        |

Each service is a layer, so a team can replace one with its own implementation, and tests can use fakes.
