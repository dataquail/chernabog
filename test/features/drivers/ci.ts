// The ci driver (ADR 22, decision 7): the domain layer over the real CLI as a
// repo's GitHub Actions workflow runs it (ADR 20), with no daemon. It sets the
// machine up, acts and reads the world as the sandbox driver does
// (on-sandbox.ts), against the same fake GitHub and fake agents.
//
// The machine works in ticks, each one run of the workflow: the plan job,
// `ci plan` as the schedule's sweep, then a `ci run` job for each item in its
// matrix, at most its max-parallel at once. Each job has a home and a clone of
// its own, as a runner's are, so nothing a job keeps outside GitHub reaches
// the next: a run that would park on a laptop ends its job there, and a later
// job takes the item's next phase. A job's home starts from the sandbox's
// machine config, enrolling its own clone, as ci run's own tests give one
// (test/acceptance/ci-run.test.ts): it stands in for the one a runner writes
// for itself, which acts as a single persona, so that the cast's personas
// each run their own flows. The workflow run's id goes to its plan and run
// jobs alike, so a plan reserves each item it starts for its run job (#519).
//
// A wait ticks until what it waits for can be seen, failing once a plan
// starts nothing and it still can't, or after MAX_TICKS. Settling ticks until
// a plan starts nothing: what the workflow would do next, it has done.

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { Sandbox } from "../../acceptance/sandbox.ts";
import type { DomainFailed, World } from "../domain.ts";
import type { Driver } from "../runner.ts";
import { RECIPES } from "./cast.ts";
import { failed, openOn, worldOf } from "./on-sandbox.ts";

// How many workflow runs one wait or settle may take.
const MAX_TICKS = 12;

// How many lines of each of the last jobs' output a failure shows.
const SHOWN_JOBS = 6;
const SHOWN_LINES = 15;

// The event a scheduled workflow run is for, as Actions writes it.
const SCHEDULED = `{"schedule":"*/10 * * * *"}`;

// The workflow run ids start here, apart from any a test names.
const FIRST_RUN = 9000;

const Matrix = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ flow: Schema.String, persona: Schema.String, item: Schema.String })),
);

type Entry = (typeof Matrix)["Type"][number];

type Running = {
  readonly sandbox: Sandbox;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  // How many jobs have had a directory, and workflow runs an id.
  jobs: number;
  workflowRuns: number;
  // What each job said, latest last, for a failure to show.
  readonly said: Array<string>;
};

// A runner's directory for a job: a home of its own, with the sandbox's
// machine config enrolling a clone of its own, and the files a step writes.
const runnerFor = (running: Running, name: string) =>
  Effect.gen(function* () {
    const { fs, path, sandbox } = running;
    running.jobs += 1;
    const job = path.join(sandbox.root, "ci", `${running.jobs}-${name}`);
    const home = path.join(job, "home");
    const checkout = path.join(job, "checkout");
    yield* fs.makeDirectory(home, { recursive: true });

    yield* Effect.try({
      try: () => sandbox.git(sandbox.root, "clone", "-q", sandbox.bare, checkout),
      catch: (error) => failed(`the runner's clone failed: ${String(error)}`),
    });

    const machineConfig = yield* fs.readFileString(sandbox.machineConfig);
    yield* fs.writeFileString(
      path.join(home, "config.yaml"),
      machineConfig.replaceAll(sandbox.checkout, checkout),
    );

    const output = path.join(job, "github-output");
    yield* fs.writeFileString(output, "");
    const event = path.join(job, "event.json");
    yield* fs.writeFileString(event, SCHEDULED);

    return { job, home, output, event, logs: path.join(job, "logs") };
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(failed(`a runner for ${name} couldn't be set up: ${error.message}`)),
    ),
  );

type Runner = Effect.Success<ReturnType<typeof runnerFor>>;

// Runs a job's command on its runner, keeping what it said.
const job = (
  running: Running,
  runner: Runner,
  name: string,
  args: ReadonlyArray<string>,
  workflowRun: number,
) =>
  Effect.tryPromise({
    try: () =>
      running.sandbox.runCli(args, {
        CHERNABOG_HOME: runner.home,
        GITHUB_RUN_ID: String(workflowRun),
        GITHUB_OUTPUT: runner.output,
      }),
    catch: (error) => failed(`${name} didn't run: ${String(error)}`),
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        running.said.push(`${name} (exit ${result.code}):\n${result.output}`);
      }),
    ),
  );

// The plan job's matrix and max-parallel, from what it wrote to GITHUB_OUTPUT.
const plannedIn = (running: Running, runner: Runner) =>
  Effect.gen(function* () {
    const written = yield* running.fs
      .readFileString(runner.output)
      .pipe(Effect.mapError((error) => failed(`the plan job's output: ${error.message}`)));

    const items = yield* Effect.fromOption(
      Option.fromNullishOr(/^items=(.*)$/m.exec(written)?.[1]),
    ).pipe(Effect.mapError(() => failed("the plan job wrote no items")));

    const matrix = yield* Schema.decodeEffect(Matrix)(items).pipe(
      Effect.mapError((error) => failed(`the plan job's items can't be read: ${error.message}`)),
    );

    const maxParallel = Option.getOrElse(
      Option.map(Option.fromNullishOr(/^max-parallel=(\d+)$/m.exec(written)?.[1]), Number),
      () => 1,
    );

    return { matrix, maxParallel };
  });

// One run of the workflow: the plan job, as the schedule's sweep, then a run
// job for each item it starts. How many it started.
const tick = (running: Running) =>
  Effect.gen(function* () {
    running.workflowRuns += 1;
    const workflowRun = FIRST_RUN + running.workflowRuns;
    const planner = yield* runnerFor(running, "plan");

    const plan = yield* job(
      running,
      planner,
      `plan ${workflowRun}`,
      ["ci", "plan", "--repo", "demo", "--event", "schedule", "--event-path", planner.event],
      workflowRun,
    );

    if (plan.code !== 0) {
      return yield* failed(`the plan job failed:\n${plan.output}`);
    }

    const { matrix, maxParallel } = yield* plannedIn(running, planner);

    yield* Effect.forEach(
      matrix,
      (entry: Entry) =>
        Effect.flatMap(runnerFor(running, `run-${entry.flow}`), (runner) =>
          job(
            running,
            runner,
            `${entry.flow} as ${entry.persona} on ${entry.item}`,
            [
              ...["ci", "run", "--repo", "demo", "--flow", entry.flow],
              ...["--persona", entry.persona, "--item", entry.item, "--logs", runner.logs],
            ],
            workflowRun,
          ),
        ),
      { concurrency: maxParallel, discard: true },
    );

    return matrix.length;
  });

// The ends of the last jobs' output, for a failure to show what they did.
const lastSaid = ({ said }: Running) =>
  `the last jobs said:\n${said
    .slice(-SHOWN_JOBS)
    .map((text) => text.trimEnd().split("\n").slice(-SHOWN_LINES).join("\n"))
    .join("\n---\n")}`;

// How ticking for something ended: it was found, a plan started nothing and
// it still wasn't, or MAX_TICKS went by.
type Ticked<A> =
  | { readonly kind: "found"; readonly found: A }
  | { readonly kind: "idle" }
  | { readonly kind: "exhausted" };

// Ticks until `find` finds something in the world, or a plan starts nothing.
const ticking = <A>(
  running: Running,
  find: (world: World) => Option.Option<A>,
): Effect.Effect<Ticked<A>, DomainFailed> =>
  Effect.gen(function* () {
    for (let ticks = 0; ticks < MAX_TICKS; ticks += 1) {
      const found = find(worldOf(running.sandbox));

      if (Option.isSome(found)) {
        return { kind: "found", found: found.value };
      }

      if ((yield* tick(running)) === 0) {
        return Option.match(find(worldOf(running.sandbox)), {
          onNone: (): Ticked<A> => ({ kind: "idle" }),
          onSome: (value): Ticked<A> => ({ kind: "found", found: value }),
        });
      }
    }

    return { kind: "exhausted" };
  });

const waitUntil = <A>(
  running: Running,
  description: string,
  find: (world: World) => Option.Option<A>,
) =>
  Effect.flatMap(ticking(running, find), (ticked) => {
    switch (ticked.kind) {
      case "found":
        return Effect.succeed(ticked.found);
      case "idle":
        return Effect.fail(
          failed(
            `waited for ${description}, and the workflow starts nothing more; ${lastSaid(running)}`,
          ),
        );
      case "exhausted":
        return Effect.fail(
          failed(
            `waited for ${description} through ${MAX_TICKS} workflow runs; ${lastSaid(running)}`,
          ),
        );
    }
  });

const settle = (running: Running) =>
  Effect.flatMap(
    ticking(running, () => Option.none<never>()),
    (ticked) =>
      Option.match(
        Option.liftPredicate(ticked, (found) => found.kind === "idle"),
        {
          onSome: () => Effect.void,
          onNone: () =>
            Effect.fail(
              failed(
                `it never settled: ${MAX_TICKS} workflow runs each started something; ${lastSaid(running)}`,
              ),
            ),
        },
      ),
  );

export const ci: Driver = {
  name: "ci",
  open: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    return yield* openOn<Running>({
      // Every cast flow on, at its default schedule: only the workflow runs them.
      on: {},
      repoConfig: { ci: { flows: [...RECIPES] } },
      make: (sandbox) => ({ sandbox, fs, path, jobs: 0, workflowRuns: 0, said: [] }),
      start: () => Effect.void,
      // Each job ends before its tick does, so nothing is left running.
      stop: () => Effect.void,
      waitUntil,
      settle,
    });
  }),
  timeout: 360_000,
};
