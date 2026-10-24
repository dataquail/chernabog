// `chernabog rehearse <flow> --scenario <file>` (#115): runs the repo's own
// flow file end to end, through the same path as `chernabog run`, with this
// machine's personas, routing and reviewer pool and real GitHub, but on the
// scenario's repo, which is seeded first and cleaned up after, and with a
// stand-in wherever the agent would be. No agent session starts.

import {
  HEADLESS,
  Implement,
  isManual,
  type RepoSettings,
  triggerOf,
  type WorkItem,
} from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";

import { asSuffix, type Persona } from "../../../kernel/persona.value-object.ts";
import { sameLogin } from "../../../kernel/reviewer-pool.value-object.ts";
import { runLabel } from "../../../kernel/run-id.id.ts";
import { type Ending } from "../../../kernel/scenario.value-object.ts";
import { pauseRepoUseCase } from "../../../modules/enrollment/use-cases/pause-repo.use-case.ts";
import { resumeRepoUseCase } from "../../../modules/enrollment/use-cases/resume-repo.use-case.ts";
import { checkRehearsalUseCase } from "../../../modules/rehearsals/use-cases/check-rehearsal.use-case.ts";
import { chooseSeededWorkUseCase } from "../../../modules/rehearsals/use-cases/choose-seeded-work.use-case.ts";
import { cleanUpScenarioUseCase } from "../../../modules/rehearsals/use-cases/clean-up-scenario.use-case.ts";
import { loadScenarioUseCase } from "../../../modules/rehearsals/use-cases/load-scenario.use-case.ts";
import { planRehearsalUseCase } from "../../../modules/rehearsals/use-cases/plan-rehearsal.use-case.ts";
import { type LoadedScenario } from "../../../modules/rehearsals/use-cases/scenario.result.ts";
import { seedScenarioUseCase } from "../../../modules/rehearsals/use-cases/seed-scenario.use-case.ts";
import { routeItems } from "../../../modules/runs/domain/routing/routing.value-object.ts";
import { withRepo } from "../../../modules/runs/infrastructure/clients/flows.client-live.ts";
import {
  runAnswers,
  runUnanswered,
} from "../../../modules/runs/infrastructure/runtime/agents/answers.ts";
import { REHEARSAL } from "../../../modules/runs/infrastructure/runtime/agents/rehearsal.ts";
import {
  type FlowHandle,
  flowHandle,
  flowLayer,
  runLogFile,
} from "../../../modules/runs/infrastructure/runtime/engine.ts";
import {
  desiredLabels,
  syncLabels,
  withFlowLabels,
} from "../../../modules/runs/infrastructure/runtime/labels.ts";
import {
  buildPersonaContexts,
  loginOf,
  openRepo,
  type RepoContext,
  servicesFrom,
  unreportedItem,
} from "../../../modules/runs/infrastructure/runtime/repo-runtime.ts";
import { RuntimeLayer, StateAt } from "../../../modules/runs/runs.layer.ts";
import { deliverSignalsUseCase } from "../../../modules/runs/use-cases/deliver-signals.use-case.ts";
import { pollRunUseCase } from "../../../modules/runs/use-cases/poll-run.use-case.ts";
import { resolveRunIdUseCase } from "../../../modules/runs/use-cases/resolve-run-id.use-case.ts";
import { type RunView } from "../../../modules/runs/use-cases/run.result.ts";
import { startFlowRunUseCase } from "../../../modules/runs/use-cases/start-flow-run.use-case.ts";
import { ConfigError } from "../../../platform/config-error.ts";
import { execOk } from "../../../platform/exec.ts";
import { reviewingFlows } from "../../../platform/flow-loader.ts";
import { GitHubApi } from "../../../platform/github-api.ts";
import { execOptionsFor } from "../../../platform/github-auth.ts";
import { Home, homePaths } from "../../../platform/home.ts";
import {
  type EffectiveRepo,
  findEnrolled,
  flowOff,
  loadMachineConfig,
  type MachineConfig,
  personaOf,
  type PersonaRepo,
  routingOf,
} from "../../../repo-config.ts";
import { fail } from "../cli.output.ts";
import { repoFlag } from "../repo.arguments.ts";
import { choosePersona, tailer } from "../runs/run.main.ts";

// What seeding made, as its use-case answers.
type Seeded = Effect.Success<ReturnType<typeof seedScenarioUseCase>>;

// The stand-ins a rehearsal runs with, as planning answers them.
type StandIns = Effect.Success<ReturnType<typeof planRehearsalUseCase>>["standIns"];

// A list for a sentence, or `none` when it's empty.
const listed = (items: ReadonlyArray<string>, none: string) =>
  Option.getOrElse(
    Option.liftPredicate(items.join(", "), (text) => text.length > 0),
    () => none,
  );

export type RehearseOptions = {
  readonly repo: string;
  readonly flow: string;
  readonly scenario: string;
  readonly item: Option.Option<string>;
  readonly persona: Option.Option<string>;
  readonly replay: Option.Option<string>;
  readonly keep: boolean;
  readonly onEnrolled: boolean;
  readonly trusted: boolean;
  readonly timeout: Duration.Duration;
};

// Where a rehearsal works on this machine: a clone of the scenario's repo,
// a journal of its own (so a rehearsal never meets a real run, and runs
// beside the daemon), and the name its run and worktrees go by.
type Scratch = {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly checkout: string;
  readonly base: string;
};

const SIGNAL_EVERY_MS = 15_000;

// The repo's settings as a rehearsal runs them: on the scenario's repo and
// its clone, with the scenario's install and local gate, no board (seeding puts nothing
// on one), and the rehearsal agent for every agent call.
const rehearsing = (
  settings: RepoSettings,
  scratch: Scratch,
  loaded: LoadedScenario,
): RepoSettings => ({
  ...settings,
  name: scratch.name,
  slug: loaded.scenario.repo,
  path: scratch.checkout,
  baseBranch: scratch.base,
  install: Option.getOrElse(
    Option.fromUndefinedOr(loaded.scenario.install),
    () => settings.install,
  ),
  localGate: loaded.scenario.localGate ?? settings.localGate,
  board: Option.none(),
  agent: REHEARSAL,
  launcher: HEADLESS,
});

const rehearsalRepo = (
  repo: EffectiveRepo,
  scratch: Scratch,
  loaded: LoadedScenario,
): EffectiveRepo => {
  const [first, ...rest] = repo.personas.map((own): PersonaRepo => ({
    ...own,
    settings: rehearsing(own.settings, scratch, loaded),
  }));

  return { settings: rehearsing(repo.settings, scratch, loaded), personas: [first, ...rest] };
};

const randomId = Effect.map(
  Effect.forEach(Arr.range(1, 8), () => Random.nextIntBetween(0, 16)),
  (digits) => digits.map((digit) => digit.toString(16)).join(""),
);

// Where the scenario's repo clones from: an enrolled repo's own origin, so an
// ssh or GitHub Enterprise origin works as the checkout does; else GitHub.
const cloneUrl = (loaded: LoadedScenario, checkout: string) => {
  if (!loaded.enrolled) {
    return Effect.succeed(`https://github.com/${loaded.scenario.repo}.git`);
  }

  return Effect.map(execOk("git", ["remote", "get-url", "origin"], { cwd: checkout }), (url) =>
    url.trim(),
  );
};

// A fresh clone of the scenario's repo, as the persona, and its default branch.
const cloneScratch = (url: string, persona: Persona) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const id = yield* randomId;
    const root = `${homePaths((yield* Home).root).rehearsals}/${id}`;
    const checkout = `${root}/checkout`;
    yield* fs.makeDirectory(root, { recursive: true });

    yield* execOk(
      "git",
      ["clone", "--quiet", "--filter=blob:none", url, checkout],
      yield* execOptionsFor(persona, { cwd: root }),
    );

    const base = (yield* execOk("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: checkout,
    })).trim();

    return { id, name: `rehearsal-${id}`, root, checkout, base } satisfies Scratch;
  });

// What a pick found, and if nothing, why; `unseen` when the trigger may yet see it.
type Picked = {
  readonly item: Option.Option<WorkItem>;
  readonly unseen: boolean;
  readonly why: string;
};

// What a rehearsal runs on: the item named, or else the first seeded item
// the trigger reports that routing leaves to this persona. Nothing else, so
// a rehearsal on a repo with real work queued never touches that work.
const pickItem = (
  handle: FlowHandle,
  persona: Persona,
  seeded: Seeded,
  named: Option.Option<string>,
  context: RepoContext,
) =>
  Effect.gen(function* () {
    const flow = handle.flow;
    const manual = isManual(flow);
    let reported: ReadonlyArray<WorkItem> = [];

    if (!manual) {
      reported = yield* withRepo(context, triggerOf(flow));
    }

    // A manual flow finds its work only by key, so each seeded thing is tried by its own.
    const keys = Option.match(named, {
      onSome: (key) => [key],
      onNone: () => [
        ...seeded.issues.map((issue) => `issue-${issue.number}`),
        ...seeded.pullRequests.map((pull) => `pr-${pull.number}`),
      ],
    });

    const found = [...reported];

    // A key the trigger didn't report is looked up by it, where the flow can.
    if (manual || Option.isSome(named)) {
      for (const key of keys) {
        for (const more of yield* withRepo(
          context,
          unreportedItem(flow, Option.some(key), found),
        )) {
          found.push(more);
        }
      }
    }

    const usable = found.filter((candidate) => candidate.wakeOnly !== true);

    const seededKeys = yield* chooseSeededWorkUseCase(
      seeded,
      usable.map((item) => item.key),
    );

    const ours = usable.filter((item) => seededKeys.includes(item.key));

    if (Option.isSome(named)) {
      return {
        item: Arr.findFirst(ours, (candidate) => candidate.key === named.value),
        unseen: true,
        why: `the trigger found no seeded item ${named.value}; a rehearsal runs only on what it seeded`,
      } satisfies Picked;
    }

    const login = yield* loginOf(handle.repo, persona);
    const own = yield* Effect.fromOption(personaOf(handle.repo, persona)).pipe(Effect.orDie);
    const routed = routeItems(ours, routingOf(own, handle.name), login);

    return Option.match(Arr.head(routed.elsewhere), {
      onNone: (): Picked => ({
        item: Arr.head(routed.mine),
        unseen: true,
        why: `the trigger found nothing seeded for ${handle.name}: it reported ${listed(
          found.map((item) => item.key),
          "nothing",
        )}`,
      }),
      onSome: (): Picked => ({
        item: Arr.head(routed.mine),
        unseen: false,
        why: `routing leaves ${routed.elsewhere.map((item) => item.key).join(", ")} to other personas or machines, not${asSuffix(persona)} here`,
      }),
    });
  });

// GitHub's search, which triggers read, can take a minute to index a new
// issue, so a rehearsal gives the trigger that long to see what was seeded.
const SEARCH_LAG = Duration.minutes(2);

const pickSeeded = (
  handle: FlowHandle,
  persona: Persona,
  seeded: Seeded,
  named: Option.Option<string>,
  context: RepoContext,
) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(SEARCH_LAG);
    let picked = yield* pickItem(handle, persona, seeded, named, context);
    let waited = false;

    while (
      Option.isNone(picked.item) &&
      picked.unseen &&
      (yield* Clock.currentTimeMillis) < deadline
    ) {
      if (!waited) {
        yield* Console.log("waiting for the trigger to see what was seeded (GitHub's search lags)");
        waited = true;
      }

      yield* Effect.sleep("5 seconds");
      picked = yield* pickItem(handle, persona, seeded, named, context);
    }

    if (Option.isNone(picked.item)) {
      yield* Console.log(picked.why);
    }

    return picked.item;
  });

// Follows a run's log until it ends, or `timeout` passes, delivering the
// signals the trigger sees (a push, a review) as `chernabog run` does.
const follow = (
  handle: FlowHandle,
  persona: Persona,
  started: RunView,
  context: RepoContext,
  timeout: Duration.Duration,
) =>
  Effect.gen(function* () {
    const tail = tailer(yield* runLogFile(started.id));
    const ref = { repo: handle.repo.settings.name, flow: handle.name, persona };
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(timeout);
    let current = started;
    let lastSignals = yield* Clock.currentTimeMillis;

    while (current.status === "running" && (yield* Clock.currentTimeMillis) < deadline) {
      yield* tail;
      yield* Effect.sleep("1 second");
      current = Option.getOrElse((yield* pollRunUseCase(current.id)).run, () => current);
      const now = yield* Clock.currentTimeMillis;

      if (now - lastSignals > SIGNAL_EVERY_MS) {
        lastSignals = now;

        const items = yield* withRepo(context, triggerOf(handle.flow)).pipe(
          Effect.orElseSucceed(() => []),
        );

        yield* deliverSignalsUseCase(ref, items);
      }
    }

    yield* tail;

    return current;
  });

// Who reviews as each login here: a persona of the repo that runs a flow that reviews.
const reviewsHere = (repo: EffectiveRepo, reviewing: ReadonlyArray<string>, login: string) =>
  repo.personas.some(
    (own) =>
      Option.exists(own.persona, (mine) => sameLogin(mine, login)) &&
      reviewing.some((flow) => Option.isNone(flowOff(own, flow))),
  );

const describeSeeded = (seeded: Seeded) =>
  listed(
    [
      ...seeded.issues.map((issue) => `issue #${issue.number} (${issue.name})`),
      ...seeded.pullRequests
        .filter((pull) => pull.number > 0)
        .map((pull) => `pull request #${pull.number} (${pull.name})`),
    ],
    "nothing",
  );

// A replayed run's answers, by step, with the commits each step made.
const replayedAnswers = (replay: Option.Option<string>) =>
  Option.match(replay, {
    onNone: () => Effect.succeed([]),
    onSome: (asked) =>
      Effect.gen(function* () {
        const { runId } = yield* resolveRunIdUseCase(asked);
        const answers = yield* runAnswers(runId);

        if (Option.isNone(answers)) {
          return yield* new ConfigError({
            message: `run ${runId} recorded no agent answers to replay; only runs since chernabog recorded them can be`,
          });
        }

        yield* Console.log(
          `replaying ${runId}: ${answers.value.map((answer) => answer.step).join(", ")}`,
        );

        return answers.value;
      }),
  });

// The rehearsal's own engine and journal, and the run it starts there.
const runRehearsal = (
  handle: FlowHandle,
  persona: Persona,
  seeded: Seeded,
  scratch: Scratch,
  machine: MachineConfig,
  options: RehearseOptions,
) =>
  Effect.gen(function* () {
    const contexts = yield* buildPersonaContexts(handle.repo, machine);

    const context = yield* yield* Effect.fromOption(servicesFrom(contexts)(persona)).pipe(
      Effect.orDie,
    );

    const engine = yield* Layer.build(
      RuntimeLayer({
        handles: [handle],
        services: (_repo, one) => servicesFrom(contexts)(one),
      }).pipe(
        Layer.provideMerge(
          flowLayer(handle, servicesFrom(contexts)).pipe(
            Layer.provideMerge(StateAt(`${scratch.root}/state.db`)),
          ),
        ),
      ),
    );

    const program = Effect.gen(function* () {
      const item = yield* pickSeeded(handle, persona, seeded, options.item, context);

      if (Option.isNone(item)) {
        return Option.none<RunView>();
      }

      const { run } = yield* startFlowRunUseCase(
        { repo: handle.repo.settings.name, flow: handle.name, persona },
        item.value,
      );

      if (Option.isNone(run)) {
        return Option.none<RunView>();
      }

      yield* Console.log(
        `started ${run.value.id} (${runLabel(run.value)}) for ${item.value.key}, log: ${yield* runLogFile(run.value.id)}`,
      );

      return Option.some(yield* follow(handle, persona, run.value, context, options.timeout));
    });

    return yield* Effect.provideContext(program, engine);
  }).pipe(Effect.scoped);

// What a rehearsal found, as lines, and whether it went as the scenario said.
const report = (
  loaded: LoadedScenario,
  repo: EffectiveRepo,
  seeded: Seeded,
  ended: RunView,
  standIns: StandIns,
  seedAs: Persona,
) =>
  Effect.gen(function* () {
    const ending: Ending = ended.status;
    const summary = Option.getOrElse(ended.summary, () => "");

    if (ending === "running") {
      yield* Console.log(
        `still running at ${Option.getOrElse(ended.currentStep, () => "its start")} when the rehearsal stopped following it`,
      );
    } else {
      yield* Console.log(`ended ${ending}: ${summary}`);
    }

    const asked = Option.getOrElse(yield* runAnswers(ended.id), () => []).map(
      (answer) => answer.step,
    );

    const check = yield* checkRehearsalUseCase({
      scenario: loaded.scenario,
      seeded,
      item: ended.itemKey,
      ending,
      summary,
      branches: seeded.issues.map((issue) => Implement.branchFor(issue.number)),
      standIns,
      asked,
      as: seedAs,
    });

    const reviewing = yield* reviewingFlows(repo.settings.configDir);

    for (const asking of check.reviewRequests) {
      for (const login of asking.logins) {
        if (reviewsHere(repo, reviewing, login)) {
          yield* Console.log(
            `#${asking.pullRequest} asks ${login} to review it; ${login} reviews here`,
          );
        } else {
          yield* Console.log(
            `! #${asking.pullRequest} asks ${login} to review it, and no persona here reviews as ${login}: a real run would wait for another machine to review it`,
          );
        }
      }
    }

    for (const step of check.unused) {
      yield* Console.log(
        `! no step asked for the stand-in ${step}; the flow may no longer have it`,
      );
    }

    for (const line of check.missed) {
      yield* Console.log(`✗ ${line}`);
    }

    // Whatever the flow made of it, a step no stand-in answered fails the rehearsal.
    const unanswered = yield* runUnanswered(ended.id);

    for (const missing of unanswered) {
      yield* Console.log(`✗ the agent wasn't stood in for at ${missing.step}: ${missing.message}`);
    }

    const expectation = Option.fromUndefinedOr(loaded.scenario.expect);
    const expected = Option.isSome(expectation);

    if (expected && check.missed.length === 0) {
      yield* Console.log("✓ ended as the scenario expects");
    }

    // With no ending to expect, the run should end done.
    const expectsEnding = Option.isSome(
      Option.flatMap(expectation, (wanted) => Option.fromUndefinedOr(wanted.ends)),
    );

    if (!expectsEnding && ending !== "done") {
      yield* Console.log(`✗ ended ${ending}; a scenario that names no expect: ends: expects done`);
    }

    return (
      check.missed.length === 0 && unanswered.length === 0 && (expectsEnding || ending === "done")
    );
  });

const cleanUp = (scratch: Scratch, slug: string, seeded: Seeded, seedAs: Persona) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const cleaned = yield* cleanUpScenarioUseCase({
      repo: slug,
      seeded,
      branches: seeded.issues.map((issue) => Implement.branchFor(issue.number)),
      as: seedAs,
    });

    for (const line of cleaned.removed) {
      yield* Console.log(`cleaned up: ${line}`);
    }

    for (const line of cleaned.failed) {
      yield* Console.log(`! couldn't clean up ${line}`);
    }

    const worktrees = homePaths((yield* Home).root).worktrees(scratch.name);
    yield* fs.remove(worktrees, { recursive: true, force: true }).pipe(Effect.ignore);
    yield* fs.remove(scratch.root, { recursive: true, force: true }).pipe(Effect.ignore);
  });

// The repo pauses on this machine while a rehearsal seeds it, and resumes
// after, unless it was paused already.
const pausedMeanwhile = <A, E, R>(
  loaded: LoadedScenario,
  name: string,
  effect: Effect.Effect<A, E, R>,
) => {
  if (!loaded.enrolled) {
    return effect;
  }

  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const paused = yield* pauseRepoUseCase(name);
      yield* Console.log(
        `${loaded.scenario.repo} is enrolled here: paused it on this machine for the rehearsal; another machine's daemon may still pick up what is seeded`,
      );

      return paused.changed;
    }),
    () => effect,
    (changed) => Effect.ignore(Effect.when(resumeRepoUseCase(name), Effect.succeed(changed))),
  );
};

export const rehearse = (options: RehearseOptions) =>
  Effect.gen(function* () {
    const machine = yield* loadMachineConfig;
    const enrolled = yield* findEnrolled(machine, options.repo);

    const loaded = yield* loadScenarioUseCase({
      path: options.scenario,
      flow: options.flow,
      enrolled: machine.repos.map((entry) => entry.repo),
      allowEnrolled: options.onEnrolled,
    });

    const { flows, repo } = yield* openRepo(machine, enrolled, !options.trusted);
    const flow = Option.fromUndefinedOr(flows.get(loaded.flow));

    if (Option.isNone(flow)) {
      return yield* new ConfigError({
        message: `${repo.settings.name} has no flow named ${loaded.flow} (flows: ${[...flows.keys()].join(", ")})`,
      });
    }

    const persona = yield* choosePersona(
      repo,
      Option.orElse(options.persona, () => Option.fromUndefinedOr(loaded.scenario.persona)),
    );

    const own = yield* Effect.fromOption(personaOf(repo, persona)).pipe(Effect.orDie);

    for (const off of Option.toArray(flowOff(own, loaded.flow))) {
      yield* Console.log(
        `! ${loaded.flow}${asSuffix(persona)} is off on this machine (${off}); a real run wouldn't start it here`,
      );
    }

    const plan = yield* planRehearsalUseCase(
      loaded.scenario,
      yield* replayedAnswers(options.replay),
    );

    const seedAs = Option.orElse(Option.fromUndefinedOr(loaded.scenario.given?.as), () => persona);

    yield* Console.log(
      `rehearsing ${loaded.flow}${asSuffix(persona)} from ${repo.settings.name} on ${loaded.scenario.repo}`,
    );

    return yield* pausedMeanwhile(
      loaded,
      repo.settings.name,
      Effect.gen(function* () {
        const scratch = yield* cloneScratch(yield* cloneUrl(loaded, enrolled.path), persona);
        const scratchRepo = rehearsalRepo(repo, scratch, loaded);

        const scratchMachine: MachineConfig = {
          ...machine,
          agents: {
            [REHEARSAL]: { standIns: plan.standIns, dir: loaded.scenario.dir, exclusive: true },
          },
        };

        const labels = yield* syncLabels(
          loaded.scenario.repo,
          withFlowLabels(desiredLabels(repo.settings.labels), flows.values()),
        ).pipe(Effect.provideContext(yield* Layer.build(GitHubApi.layerFor(seedAs))));

        yield* Console.log(labels);

        const seeding = yield* Effect.result(seedScenarioUseCase(loaded.scenario, seedAs));

        // A seeding that fails partway still cleans up what it made.
        const seeded = yield* Effect.catchTag(
          Effect.fromResult(seeding),
          "SeedingFailed",
          (error) =>
            Effect.andThen(
              cleanUp(scratch, loaded.scenario.repo, error.seeded, seedAs),
              Effect.fail(
                new ConfigError({ message: `seeding ${loaded.scenario.repo}: ${error.message}` }),
              ),
            ),
        );

        yield* Console.log(`seeded ${describeSeeded(seeded)} on ${loaded.scenario.repo}`);

        const ran = Effect.gen(function* () {
          const handle = flowHandle(scratchRepo, loaded.flow, flow.value);

          const ended = yield* runRehearsal(
            handle,
            persona,
            seeded,
            scratch,
            scratchMachine,
            options,
          );

          return yield* Option.match(ended, {
            onNone: () => Effect.succeed(false),
            onSome: (run) => report(loaded, repo, seeded, run, plan.standIns, seedAs),
          });
        });

        return yield* ran.pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              if (options.keep) {
                return Console.log(
                  `kept what was seeded on ${loaded.scenario.repo} (${describeSeeded(seeded)}), and the clone and journal in ${scratch.root}`,
                );
              }

              return cleanUp(scratch, loaded.scenario.repo, seeded, seedAs);
            }),
          ),
        );
      }),
    );
  }).pipe(Effect.scoped);

export const rehearseCommand = Command.make(
  "rehearse",
  {
    flow: Argument.String("flow"),
    repo: repoFlag,
    scenario: Flag.File("scenario", { mustExist: true }).pipe(
      Flag.withDescription(
        "The scenario to rehearse, such as .chernabog/rehearsals/implement.yaml",
      ),
    ),
    item: Flag.String("item").pipe(
      Flag.withDescription("A seeded work item to run on, such as issue-12, by the flow's key"),
      Flag.optional,
    ),
    as: Flag.String("as").pipe(
      Flag.withDescription("The GitHub persona to rehearse as, for a flow that runs as several"),
      Flag.optional,
    ),
    replay: Flag.String("replay").pipe(
      Flag.withDescription("A finished run whose agent answers stand in, by enough of its id"),
      Flag.optional,
    ),
    keep: Flag.Boolean("keep").pipe(
      Flag.withDescription("Leave what was seeded, and the clone, for a look"),
      Flag.withDefault(false),
    ),
    onEnrolled: Flag.Boolean("on-enrolled").pipe(
      Flag.withDescription(
        "Allow a scenario whose repo is enrolled here; the repo pauses here meanwhile",
      ),
      Flag.withDefault(false),
    ),
    trusted: Flag.Boolean("trusted").pipe(
      Flag.withDescription(
        "Rehearse the trusted .chernabog/ on the base branch, not the working copy's",
      ),
      Flag.withDefault(false),
    ),
    timeout: Flag.Int("timeout").pipe(
      Flag.withDescription("Minutes to follow the run before reporting where it waits"),
      Flag.withDefault(30),
    ),
  },
  ({ as, flow, item, keep, onEnrolled, replay, repo, scenario, timeout, trusted }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const ok = yield* rehearse({
        repo,
        flow,
        scenario: yield* fs.realPath(scenario),
        item,
        persona: as,
        replay,
        keep,
        onEnrolled,
        trusted,
        timeout: Duration.minutes(timeout),
      });

      if (!ok) {
        yield* fail("the rehearsal didn't go as its scenario says");
      }
    }),
).pipe(
  Command.withDescription(
    "Run a flow end to end on a scratch repo, seeded from a scenario, with stand-ins for the agent",
  ),
);
