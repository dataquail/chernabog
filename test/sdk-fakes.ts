// An in-memory repo for running SDK steps and whole flows through the engine:
// one issue, the pull request a flow opens for it, the git and CI behind it,
// and an agent that answers whatever shape a step asks for.

import { fileURLToPath } from "node:url";

import {
  Agent,
  AgentError,
  type AgentRequest,
  type CiState,
  type Comment,
  DEFAULT_LABELS,
  type Flow,
  Git,
  GitHub,
  HEADLESS,
  type Issue,
  type Json,
  type MergeOutcome,
  type MergeRequest,
  printJson,
  type PullRequest,
  Repo,
  type RepoSettings,
  type ReviewEvent,
  RunLog,
  Runs,
  StepRunner,
  type SubmittedReview,
  Usage,
  type WorkItem,
  Worktree,
} from "@chernabog/sdk";
import type { BunServices } from "@effect/platform-bun";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { IMPLICIT, type Persona } from "../src/kernel/persona.value-object.ts";
import {
  type FlowHandle,
  flowLayer,
  forEveryPersona,
} from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { type RunsLayer, RuntimeLayer, StateAt } from "../src/modules/runs/runs.layer.ts";
import { deliverSignalsUseCase } from "../src/modules/runs/use-cases/deliver-signals.use-case.ts";
import { pollRunUseCase } from "../src/modules/runs/use-cases/poll-run.use-case.ts";
import type { ActiveRun, RunView } from "../src/modules/runs/use-cases/run.result.ts";
import { startFlowRunUseCase } from "../src/modules/runs/use-cases/start-flow-run.use-case.ts";
import { Home, homePaths } from "../src/platform/home.ts";
import { DEFAULT_LIMITS, type EffectiveRepo, type PersonaRepo } from "../src/repo-config.ts";

export const PULL = 7;
export const ISSUE = 3;

// The head the first push makes; each later push moves it.
export const HEAD = "abc1234def";

export const settings: RepoSettings = {
  name: "demo",
  slug: "dataquail/demo",
  path: "/tmp/demo",
  baseBranch: "main",
  account: {
    name: "work",
    configDir: Option.none(),
    expectedEmail: Option.none(),
    oauthTokenEnv: Option.none<string>(),
    usageGate: "usage" as const,
  },
  agent: "claude",
  agentAccounts: {},
  launcher: HEADLESS,
  flowAgents: {},
  labels: DEFAULT_LABELS,
  install: Option.none(),
  localGate: [],
  humanOnly: [],
  humanOnlyPaths: [".github/**"],
  notes: [],
  board: Option.none(),
  reviewTrigger: Option.none(),
  limits: DEFAULT_LIMITS,
  env: {},
  // The recipes' prompts, which the implement and review steps render.
  configDir: fileURLToPath(new URL("../templates/recipes", import.meta.url)),
};

// A repo as one persona runs it, with nothing chosen of its own.
export const asPersona = (repoSettings: RepoSettings, persona: Persona): PersonaRepo => ({
  persona,
  settings: repoSettings,
  enabled: true,
  schedule: { own: Option.none(), repo: Option.none() },
  activeHours: Option.none(),
  flows: {},
  chosen: [],
  own: {},
  teamFlows: {},
});

// A repo run as these personas: the implicit one, unless named.
export const repoAs = (
  repoSettings: RepoSettings,
  personas: Arr.NonEmptyReadonlyArray<Persona> = [Option.none()],
): EffectiveRepo => ({
  settings: repoSettings,
  personas: Arr.map(personas, (persona) => asPersona(repoSettings, persona)),
});

export const repo = repoAs(settings);

export type Verdict = "approve" | "request-changes";

// A review's state on GitHub once it's submitted with its event.
const STATE_OF: Readonly<Record<ReviewEvent, string>> = {
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
  COMMENT: "COMMENTED",
};

// CI on the head, the files the pull request changes, whether GitHub refuses the merge, and the merges asked for.
export type MergeFake = {
  ci: CiState;
  files: Array<string>;
  refusal: Option.Option<string>;
  requests: Array<MergeRequest>;
};

// One issue and its pull request, and what the steps did to them. Reviews
// answer `verdicts` in turn, the last one repeating.
export const makeFake = (
  verdicts: Verdict | ReadonlyArray<Verdict>,
  overrides: Partial<RepoSettings> = {},
) => {
  const queue = [verdicts].flat();

  const labels = new Map<number, Array<string>>([
    [PULL, [DEFAULT_LABELS.needsReview]],
    [ISSUE, [DEFAULT_LABELS.inProgress]],
  ]);

  const comments: Array<Comment> = [];
  const reviews: Array<string> = [];
  // Who this run acts as, who the pull request asks to review it, and the reviews submitted on it.
  const people = { me: "chernabog-bot", requested: new Array<string>() };
  const submitted: Array<SubmittedReview> = [];
  const adapters: Array<Option.Option<string>> = [];
  const requests: Array<AgentRequest> = [];
  const labelsOf = (number: number) => labels.get(number) ?? [];

  const merge: MergeFake = {
    ci: { state: "green" },
    files: ["src/a.ts"],
    refusal: Option.none(),
    requests: [],
  };

  // The pushed head, pushes so far, whether the pull request is open, and the commits the agent made since the last push.
  const git = { head: HEAD, pushes: 0, opened: false, commits: 0 };

  // The worktree's head: the pushed one, or a commit of the agent's on top.
  const localHead = () => {
    if (git.commits > 0) {
      return `local${git.commits}000000`;
    }

    return git.head;
  };

  // How the author answers a review it is asked to consider, and whether the person closes a session with them before it answers.
  const author = { consider: "address", closes: false };
  // Whether the issue's branch exists already, as an earlier run left it.
  const existing = { branch: false };
  let reviewed = 0;

  // What this machine knows of the run that owns the pull request: nothing, unless a test says.
  let knownRun = Option.none<boolean>();

  const knowRun = (active: boolean) => {
    knownRun = Option.some(active);
  };

  const setLabels = (number: number, names: Array<string>) => {
    labels.set(number, names);
  };

  const comment = (body: string) => {
    comments.push({
      id: comments.length + 1,
      author: "chernabog-bot",
      body,
      createdAt: "2026-10-20T00:00:00Z",
      trusted: true,
    });
  };

  const nextVerdict = () => {
    reviewed += 1;

    return queue[Math.min(reviewed, queue.length) - 1] ?? "approve";
  };

  // What the agent answers, by the shape the step asked for.
  const answerFor = (request: AgentRequest): Json => {
    const schema = Option.match(request.outputSchema, { onNone: () => "", onSome: printJson });

    if (schema.includes("remediated")) {
      return {
        verdict: nextVerdict(),
        summary: "Both fixed.",
        comments: [],
        findings: [{ finding: "Mention the change", remediated: true }],
      };
    }

    if (schema.includes("decline")) {
      return { status: author.consider, reasons: "The review is right." };
    }

    if (schema.includes("needs-clarification")) {
      git.commits += 1;

      return {
        status: "done",
        summary: "Mentioned the change.",
        title: "feat: a change",
        body: "The change.",
      };
    }

    // The hybrid path's open-pr, once the person and the agent are done.
    if (schema.includes('"title"')) {
      git.commits += 1;

      return {
        title: "feat: worked out together",
        body: "Built with a person.",
        summary: "Done with a person.",
      };
    }

    return {
      verdict: nextVerdict(),
      summary: "Reviewed.",
      comments: [{ path: "README.md", line: 1, body: "Mention the change." }],
    };
  };

  const pull = (): PullRequest => ({
    number: PULL,
    title: "feat: a change",
    body: "",
    url: `https://github.com/dataquail/demo/pull/${PULL}`,
    state: "open",
    headRef: `auto/issue-${ISSUE}`,
    headSha: git.head,
    baseRef: "main",
    labels: labelsOf(PULL),
    author: "chernabog-bot",
    assignees: [],
    requestedReviewers: [...people.requested],
  });

  const issue = (): Issue => ({
    number: ISSUE,
    title: "A queued issue",
    body: "",
    url: `https://github.com/dataquail/demo/issues/${ISSUE}`,
    createdAt: "2026-10-20T00:00:00Z",
    labels: labelsOf(ISSUE),
    assignees: [],
  });

  const services = Layer.mergeAll(
    Layer.succeed(Repo, Repo.of({ ...settings, ...overrides })),
    Layer.mock(GitHub)({
      queuedIssuesLabelled: (label) =>
        Effect.succeed([issue()].filter((queued) => queued.labels.includes(label))),
      issue: () => Effect.succeed(issue()),
      trustedComments: () => Effect.succeed([]),
      branchSha: () => Effect.succeedSome("base1234"),
      createBranch: () =>
        Effect.sync((): "created" | "already-exists" => {
          if (existing.branch) {
            return "already-exists";
          }

          return "created";
        }),
      deleteBranch: () => Effect.void,
      assignSelf: () => Effect.void,
      moveToStatus: () => Effect.void,
      pullRequestForBranch: () =>
        Effect.sync(() => Option.filter(Option.some(pull()), () => git.opened)),
      openPullRequest: () =>
        Effect.sync(() => {
          git.opened = true;

          return pull();
        }),
      pullRequestsLabelled: (label) =>
        Effect.sync(() => [pull()].filter((open) => open.labels.includes(label))),
      openPullRequests: Effect.sync(() => [pull()]),
      login: Effect.sync(() => people.me),
      reviews: () => Effect.sync(() => [...submitted]),
      requestReviewers: (_, logins) =>
        Effect.sync(() => {
          people.requested = [
            ...people.requested.filter((login) => !logins.includes(login)),
            ...logins,
          ];
        }),
      closedPullRequestsLabelled: () => Effect.succeed([]),
      pullRequest: () => Effect.sync(pull),
      ciState: () => Effect.sync(() => merge.ci),
      pullRequestFiles: () => Effect.sync(() => merge.files),
      merge: (_, request) =>
        Effect.sync((): MergeOutcome => {
          merge.requests.push(request);

          return Option.match(merge.refusal, {
            onNone: () => ({ status: "merged", sha: "merged9876" }),
            onSome: (reason) => ({ status: "refused", reason }),
          });
        }),
      comments: () => Effect.sync(() => [...comments]),
      reviewComments: () => Effect.succeed([]),
      comment: (_, body) =>
        Effect.sync(() => {
          comment(body);
        }),
      // As on GitHub, a review drops its author from the requested reviewers.
      review: (_, review) =>
        Effect.sync(() => {
          reviews.push(review.body);
          submitted.push({
            author: people.me,
            state: STATE_OF[review.event ?? "COMMENT"],
            commitSha: review.commitSha,
          });
          people.requested = people.requested.filter((login) => login !== people.me);
        }),
      addLabel: (number, label) =>
        Effect.sync(() => {
          labels.set(number, [...labelsOf(number).filter((name) => name !== label), label]);
        }),
      removeLabel: (number, label) =>
        Effect.sync(() => {
          labels.set(
            number,
            labelsOf(number).filter((name) => name !== label),
          );
        }),
    }),
    Layer.mock(Git)({
      commitsAhead: () => Effect.succeed(1),
      pull: () => Effect.void,
      headSha: () => Effect.sync(localHead),
      changedFiles: () => Effect.sync(() => merge.files),
      push: () =>
        Effect.sync(() => {
          git.pushes += 1;
          git.commits = 0;

          if (git.pushes > 1) {
            git.head = `fix${git.pushes}0000000`;
          }
        }),
    }),
    Layer.mock(Worktree)({
      pathFor: (branch) => `/tmp/demo-worktrees/${branch}`,
      ensure: (branch) => Effect.succeed(`/tmp/demo-worktrees/${branch}`),
      checkout: (name) => Effect.succeed(`/tmp/demo-worktrees/${name}`),
      remove: () => Effect.void,
    }),
    Layer.mock(Usage)({}),
    Layer.mock(Agent)({
      adapters: [],
      run: (request) =>
        Effect.suspend(() => {
          adapters.push(request.adapter);
          requests.push(request);

          if (author.closes && request.withPerson === true) {
            return Effect.fail(
              new AgentError({
                message: "claude: the person closed the session before it finished",
              }),
            );
          }

          return Effect.succeed({
            sessionId: request.sessionId,
            output: answerFor(request),
            costUsd: Option.none(),
          });
        }),
    }),
    Layer.mock(StepRunner)({}),
    Layer.succeed(Runs, Runs.of({ isActive: () => Effect.sync(() => knownRun) })),
  );

  return {
    services,
    git,
    author,
    existing,
    merge,
    requests,
    knowRun,
    labelsOf,
    setLabels,
    comments,
    reviews,
    adapters,
    comment,
    people,
    submitted,
  };
};

export type Fake = ReturnType<typeof makeFake>;

export const item = (key: string, data: Json = {}): WorkItem => ({ key, data });

// A run as the engine reports it, and the stores a test may read it back from.
export type EngineRun = RunView | ActiveRun;

export type RunsServices = Layer.Success<typeof RunsLayer>;

const isRunning = (run: EngineRun) => run.status === "running";

// A flow as a persona runs it, as the runs module names it.
const refOf = (handle: FlowHandle, persona: Persona) => ({
  repo: handle.repo.settings.name,
  flow: handle.name,
  persona,
});

// The runs module's runtime over one flow's workflow. These tests start and
// poll runs themselves, so it runs no trigger or gate.
export const runtimeFor = (handle: FlowHandle) =>
  RuntimeLayer({ handles: [handle], services: () => Option.none() });

// Starting, polling and waking runs as the daemon does, through the runs module.
export const startRun = (handle: FlowHandle, persona: Persona, work: WorkItem) =>
  startFlowRunUseCase(refOf(handle, persona), work);

export const pollRun = (run: EngineRun) =>
  pollRunUseCase(run.id).pipe(
    Effect.map((found): EngineRun => Option.getOrElse(found.run, () => run)),
  );

export const deliverSignals = (
  handle: FlowHandle,
  persona: Persona,
  items: ReadonlyArray<WorkItem>,
) => deliverSignalsUseCase(refOf(handle, persona), items).pipe(Effect.map(({ count }) => count));

// Starts a run of the flow on the fake, and polls until `until` says it has got far enough.
export const runUntil = (
  handle: FlowHandle,
  fake: Fake,
  work: WorkItem,
  until: (run: EngineRun) => Effect.Effect<boolean, never, RunsServices>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-steps-" });

    const services = forEveryPersona(yield* Layer.build(fake.services));

    const engine = yield* Layer.build(
      runtimeFor(handle).pipe(
        Layer.provideMerge(flowLayer(handle, services)),
        Layer.provideMerge(StateAt(homePaths(home).state)),
        Layer.provideMerge(Home.at(home, home)),
      ),
    );

    const platform = yield* Effect.context<BunServices.BunServices>();

    const run = startRun(handle, IMPLICIT, work).pipe(
      Effect.flatMap((started) => Effect.fromOption(started.run)),
      Effect.flatMap((started) =>
        pollRun(started).pipe(
          Effect.flatMap((polled) => until(polled).pipe(Effect.map((done) => ({ polled, done })))),
          Effect.repeat({
            schedule: Schedule.spaced("25 millis"),
            until: (step) => step.done,
            times: 200,
          }),
        ),
      ),
      Effect.map((step) => step.polled),
      Effect.orDie,
    );

    return yield* Effect.provideContext(run, Context.merge(platform, engine));
  });

export const runToEnd = (handle: FlowHandle, fake: Fake, work: WorkItem) =>
  runUntil(handle, fake, work, (run) => Effect.succeed(!isRunning(run)));

// Runs any effect, such as a flow's item lookup, against the fake.
export const onFake = <A, E, R>(fake: Fake, effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, fake.services);

// Runs a trigger against the fake, as a tick would.
export const triggered = <E, R>(
  fake: Fake,
  trigger: Effect.Effect<ReadonlyArray<WorkItem>, E, R>,
) => Effect.provide(trigger, fake.services);

// A run log that keeps nothing, for a flow's trigger run outside the engine.
const quietLog = Layer.succeed(
  RunLog,
  RunLog.of({ log: () => Effect.void, step: () => Effect.void, stepDone: () => Effect.void }),
);

// What a flow's own trigger reports on the fake.
export const flowTriggered = (fake: Fake, flow: Flow) =>
  Effect.provide(flow.trigger, Layer.mergeAll(fake.services, quietLog));

export const summaryOf = (run: EngineRun) => Option.getOrElse(run.summary, () => "");
