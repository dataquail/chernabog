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
  CurrentActivity,
  DEFAULT_LABELS,
  type Flow,
  Git,
  GitHub,
  HEADLESS,
  type Issue,
  type Json,
  type LinkedIssue,
  MergeRefused,
  type MergeRequest,
  printJson,
  type PullRequest,
  type PushRejected,
  Repo,
  type RepoSettings,
  ReviewerSeat,
  type ReviewEvent,
  RunLog,
  Runs,
  StepRunner,
  type SubmittedReview,
  triggerOf,
  Usage,
  type WorkItem,
  Worktree,
} from "@chernabog/core";
import type { BunServices } from "@effect/platform-bun";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { IMPLICIT, type Persona } from "../src/kernel/persona.value-object.ts";
import { DEFAULT_EVENT_TICK_MIN } from "../src/modules/runs/domain/schedule/event-tick.value-object.ts";
import { DEFAULT_LEASE_LIMITS } from "../src/modules/runs/domain/schedule/lease.value-object.ts";
import { DEFAULT_VALIDITY_EVERY } from "../src/modules/runs/domain/schedule/validity.value-object.ts";
import {
  type FlowHandle,
  flowLayer,
  forEveryPersona,
} from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { type RunsLayer, RuntimeLayer, StateAt } from "../src/modules/runs/runs.layer.ts";
import { deliverSignalsUseCase } from "../src/modules/runs/use-cases/deliver-signals.use-case.ts";
import { pollRunUseCase } from "../src/modules/runs/use-cases/poll-run.use-case.ts";
import { releaseMarkersUseCase } from "../src/modules/runs/use-cases/release-markers.use-case.ts";
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
  configDir: fileURLToPath(new URL("../packages/recipes", import.meta.url)),
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
  eventTickMin: DEFAULT_EVENT_TICK_MIN,
  validityEvery: DEFAULT_VALIDITY_EVERY,
  leases: DEFAULT_LEASE_LIMITS,
});

export const repo = repoAs(settings);

export type Verdict = "approve" | "request-changes";

// A review's state on GitHub once it's submitted with its event.
const STATE_OF: Readonly<Record<ReviewEvent, string>> = {
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
  COMMENT: "COMMENTED",
};

// CI on the head, the files the pull request changes, its mergeable_state on
// GitHub, whether GitHub refuses the merge, and the merges asked for.
export type MergeFake = {
  ci: CiState;
  files: Array<string>;
  state: string;
  refusal: Option.Option<string>;
  requests: Array<MergeRequest>;
};

// Whether a person closed the fake's issue, and closed or merged its pull request.
export type ItemStates = { issue: "open" | "closed"; pull: PullRequest["state"] };

// The body of a request that unassigns people from an issue.
const Unassigning = Schema.Struct({ assignees: Schema.Array(Schema.String) });

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
  const people = {
    me: "chernabog-bot",
    requested: new Array<string>(),
    // Who is assigned to the issue, and to the pull request.
    assigned: new Array<string>(),
    pullAssigned: new Array<string>(),
  };

  const submitted: Array<SubmittedReview> = [];
  const adapters: Array<Option.Option<string>> = [];
  const requests: Array<AgentRequest> = [];
  // The activity each agent call came from, as the Agent service sees it.
  const steps: Array<Option.Option<string>> = [];
  const labelsOf = (number: number) => labels.get(number) ?? [];

  const merge: MergeFake = {
    ci: { state: "green" },
    files: ["src/a.ts"],
    state: "clean",
    refusal: Option.none(),
    requests: [],
  };

  // The pushed head, pushes so far, whether the pull request is open, the
  // commits the agent made since the last push, and what the remote says to a push.
  const git = {
    head: HEAD,
    pushes: 0,
    opened: false,
    commits: 0,
    rejects: Option.none<PushRejected>(),
  };

  // The worktree's head: the pushed one, or a commit of the agent's on top.
  const localHead = () => {
    if (git.commits > 0) {
      return `local${git.commits}000000`;
    }

    return git.head;
  };

  // How the author answers a review it is asked to consider, how it answers a
  // merge conflict, and whether the person closes a session with them before it answers.
  const author = { consider: "address", resolve: "resolved", closes: false };
  // Whether the agent works on and on, as one an hour into a step does, until interrupted.
  const agent = { hangs: false };
  // The issue's Status on the repo's board, once a step moved it.
  const board = { status: Option.none<string>() };
  // Whether the issue's branch exists already, as an earlier run left it.
  const existing = { branch: false };

  // The remote's branches: each one's head, the base's unless `heads` names
  // another, and those deleted from it.
  const remote = { heads: new Map<string, string>(), gone: new Set<string>() };

  // The branch the pull request is based on: the repo's base branch, or the
  // layer below's for a stacked one, whose files a diff against the repo's
  // base branch takes in too.
  const stack = { base: "main", below: new Array<string>() };

  // What the steps based their work on: the sha each branch was created from,
  // the base each pull request targets, and the base each push was checked against.
  const based = {
    createdFrom: new Array<string>(),
    targets: new Array<string>(),
    checkedAgainst: new Array<string>(),
  };

  // Whether a person closed the issue or closed (or merged) the pull request.
  const states: ItemStates = {
    issue: "open",
    pull: "open",
  };

  // Refs other than branches, such as claims, by full name, and the commits made through the API.
  const refs = new Map<string, string>();
  const commits = new Map<string, string>();
  let reviewed = 0;

  // The issues a step made, and the sub-issue and blocked-by links between
  // them and the queued issue. `plans` are the agent's answers to a plan
  // step, in turn, the last one repeating.
  const graph = {
    made: new Map<number, LinkedIssue>(),
    subIssues: new Map<number, Array<number>>(),
    blockedBy: new Map<number, Array<number>>(),
    next: 100,
  };

  // Pull requests by head branch, apart from the one pull request, such as
  // those of an epic's other tasks.
  const branchPulls = new Map<string, PullRequest>();

  // The pull request as its author opened it: its branch, who opened it, and
  // whether it is a draft. And the open pull requests GitHub says close the
  // issue, as its GraphQL API answers closedByPullRequestsReferences.
  const authored = { headRef: `auto/issue-${ISSUE}`, author: "chernabog-bot", draft: false };
  const closing: Array<Json> = [];

  const plans: Array<Json> = [];
  // The worktrees and checkouts a step removed, by name.
  const removed: Array<string> = [];
  let planned = 0;

  // What this machine knows of the run that owns the pull request: nothing, unless a test says.
  let knownRun = Option.none<boolean>();

  const knowRun = (active: boolean) => {
    knownRun = Option.some(active);
  };

  const setLabels = (number: number, names: Array<string>) => {
    labels.set(number, names);
  };

  const comment = (body: string, by = "chernabog-bot") => {
    comments.push({
      id: comments.length + 1,
      author: by,
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

    if (schema.includes("blockedBy")) {
      planned += 1;

      return plans[Math.min(planned, plans.length) - 1] ?? {};
    }

    if (schema.includes("remediated")) {
      return {
        verdict: nextVerdict(),
        summary: "Both fixed.",
        comments: [],
        findings: [{ finding: "Mention the change", remediated: true }],
      };
    }

    // resolve-conflicts: a resolved merge is a commit.
    if (schema.includes('"resolved"')) {
      if (author.resolve === "resolved") {
        git.commits += 1;
      }

      return { status: author.resolve, summary: "Kept both sides of README.md." };
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
    state: states.pull,
    headRef: authored.headRef,
    headSha: git.head,
    baseRef: stack.base,
    labels: labelsOf(PULL),
    author: authored.author,
    assignees: [...people.pullAssigned],
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
    state: states.issue,
  });

  const known = (number: number): Option.Option<LinkedIssue> =>
    Option.orElse(Option.fromUndefinedOr(graph.made.get(number)), () =>
      Option.liftPredicate({ ...issue(), state: states.issue }, () => number === ISSUE),
    );

  const linkedTo = (links: Map<number, Array<number>>, number: number) =>
    (links.get(number) ?? []).flatMap((linked) =>
      Option.toArray(
        Option.map(known(linked), (found) => ({ ...found, labels: labelsOf(linked) })),
      ),
    );

  const link = (links: Map<number, Array<number>>, from: number, to: number) => {
    const linked = links.get(from) ?? [];

    if (!linked.includes(to)) {
      links.set(from, [...linked, to]);
    }
  };

  const allIssues = () => [
    issue(),
    ...[...graph.made.values()].map((made) => ({ ...made, labels: labelsOf(made.number) })),
  ];

  const services = Layer.mergeAll(
    Layer.succeed(Repo, Repo.of({ ...settings, ...overrides })),
    Layer.mock(GitHub)({
      queuedIssuesLabelled: (label) =>
        Effect.succeed([issue()].filter((queued) => queued.labels.includes(label))),
      issue: (number) =>
        Effect.sync(() =>
          Option.getOrElse(
            Option.map(Option.fromUndefinedOr(graph.made.get(number)), (made) => ({
              ...made,
              labels: labelsOf(number),
            })),
            issue,
          ),
        ),
      issuesLabelled: (label) =>
        Effect.sync(() => allIssues().filter((found) => found.labels.includes(label))),
      createIssue: (created) =>
        Effect.sync(() => {
          const number = graph.next;
          graph.next += 1;

          const made: LinkedIssue = {
            number,
            title: created.title,
            body: created.body,
            url: `https://github.com/dataquail/demo/issues/${number}`,
            createdAt: "2026-10-21T00:00:00Z",
            labels: [],
            assignees: [],
            state: "open",
          };

          graph.made.set(number, made);
          labels.set(number, [...created.labels]);

          return made;
        }),
      subIssues: (parent) => Effect.sync(() => linkedTo(graph.subIssues, parent)),
      addSubIssue: (parent, child) =>
        Effect.sync(() => {
          link(graph.subIssues, parent, child);
        }),
      blockedBy: (number) => Effect.sync(() => linkedTo(graph.blockedBy, number)),
      addBlockedBy: (number, blocker) =>
        Effect.sync(() => {
          link(graph.blockedBy, number, blocker);
        }),
      removeBlockedBy: (number, blocker) =>
        Effect.sync(() => {
          graph.blockedBy.set(
            number,
            (graph.blockedBy.get(number) ?? []).filter((linked) => linked !== blocker),
          );
        }),
      trustedComments: () => Effect.sync(() => comments.filter((found) => found.trusted)),
      branchSha: (name) =>
        Effect.sync(() =>
          Option.liftPredicate(remote.heads.get(name) ?? "base1234", () => !remote.gone.has(name)),
        ),
      createBranch: (_, sha) =>
        Effect.sync((): "created" | "already-exists" => {
          if (existing.branch) {
            return "already-exists";
          }

          based.createdFrom.push(sha);

          return "created";
        }),
      deleteBranch: () => Effect.void,
      createCommit: (commit) =>
        Effect.sync(() => {
          const sha = `commit${commits.size + 1}`;
          commits.set(sha, commit.message);

          return sha;
        }),
      createRef: (ref, sha) =>
        Effect.sync((): "created" | "already-exists" => {
          if (refs.has(ref)) {
            return "already-exists";
          }

          refs.set(ref, sha);

          return "created";
        }),
      ref: (ref) =>
        Effect.sync(() =>
          Option.map(Option.fromUndefinedOr(refs.get(ref)), (sha) => ({
            sha,
            message: commits.get(sha) ?? "",
          })),
        ),
      deleteRef: (ref) =>
        Effect.sync(() => {
          refs.delete(ref);
        }),
      updateRef: (ref, sha) =>
        Effect.sync(() => {
          refs.set(ref, sha);
        }),
      assignSelf: (number) =>
        Effect.sync(() => {
          if (number === PULL) {
            people.pullAssigned = [
              ...people.pullAssigned.filter((login) => login !== people.me),
              people.me,
            ];

            return;
          }

          people.assigned = [...people.assigned.filter((login) => login !== people.me), people.me];
        }),
      moveToStatus: (_, status) =>
        Effect.sync(() => {
          board.status = Option.some(status);
        }),
      pullRequestForBranch: (branch) =>
        Effect.sync(() =>
          Option.orElse(Option.fromUndefinedOr(branchPulls.get(branch)), () =>
            Option.filter(Option.some(pull()), () => git.opened),
          ),
        ),
      openPullRequest: (request) =>
        Effect.sync(() => {
          git.opened = true;
          based.targets.push(request.base);

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
      // A commit's and a branch's CI read as the pull request's, with no links to failed runs.
      commitCiState: () => Effect.sync(() => ({ ...merge.ci, failedRuns: [] })),
      branchCiState: () => Effect.sync(() => ({ ...merge.ci, failedRuns: [] })),
      ciFailureDetails: (run) => Effect.succeed({ url: run.url, logTail: Option.none() }),
      pullRequestFiles: () => Effect.sync(() => merge.files),
      merge: (pullRequest, request) =>
        Effect.suspend(() => {
          merge.requests.push(request);

          return Option.match(merge.refusal, {
            onNone: () => Effect.succeed({ sha: "merged9876" }),
            onSome: (reason) => Effect.fail(new MergeRefused({ pullRequest, reason })),
          });
        }),
      // Only the pull request itself, as GitHub's REST API answers it.
      request: (method, path, body) =>
        Effect.sync((): Json => {
          if (method === "DELETE" && path === `/repos/${settings.slug}/issues/${ISSUE}/assignees`) {
            const leaving = Option.match(body, {
              onNone: (): ReadonlyArray<string> => [],
              onSome: (sent) =>
                Option.match(Schema.decodeUnknownOption(Unassigning)(sent), {
                  onNone: (): ReadonlyArray<string> => [],
                  onSome: (unassigning) => unassigning.assignees,
                }),
            });

            people.assigned = people.assigned.filter((login) => !leaving.includes(login));

            return {};
          }

          // How far the claim branch is ahead of its base: the agent's commits, pushed or not.
          if (method === "GET" && path.startsWith(`/repos/${settings.slug}/compare/`)) {
            return { ahead_by: git.pushes + git.commits };
          }

          if (method === "GET" && path === `/repos/${settings.slug}/pulls/${PULL}`) {
            return { number: PULL, mergeable_state: merge.state, draft: authored.draft };
          }

          if (method === "POST" && path === "/graphql") {
            return {
              data: {
                repository: { issue: { closedByPullRequestsReferences: { nodes: [...closing] } } },
              },
            };
          }

          // The issues this login opened, newest first.
          if (method === "GET" && path.startsWith(`/repos/${settings.slug}/issues?`)) {
            return [...graph.made.values()]
              .toReversed()
              .map((made) => ({ number: made.number, body: made.body }));
          }

          return {};
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
      // Any other git command, such as cleaning up's: it has nothing to say.
      run: () => Effect.succeed(""),
      commitsAhead: (_, base) =>
        Effect.sync(() => {
          based.checkedAgainst.push(base);

          return 1;
        }),
      pull: () => Effect.void,
      headSha: () => Effect.sync(localHead),
      changedFiles: (_, base) =>
        Effect.sync(() => {
          based.checkedAgainst.push(base);

          if (base === stack.base) {
            return merge.files;
          }

          return [...stack.below, ...merge.files];
        }),
      push: () =>
        Effect.suspend(() => {
          if (Option.isSome(git.rejects)) {
            return Effect.fail(git.rejects.value);
          }

          git.pushes += 1;
          git.commits = 0;

          if (git.pushes > 1) {
            git.head = `fix${git.pushes}0000000`;
          }

          return Effect.void;
        }),
    }),
    Layer.mock(Worktree)({
      pathFor: (branch) => `/tmp/demo-worktrees/${branch}`,
      ensure: (branch) => Effect.succeed(`/tmp/demo-worktrees/${branch}`),
      checkout: (name) => Effect.succeed(`/tmp/demo-worktrees/${name}`),
      remove: (name) =>
        Effect.sync(() => {
          removed.push(name);
        }),
    }),
    Layer.mock(Usage)({}),
    Layer.mock(Agent)({
      adapters: [],
      run: (request) =>
        Effect.gen(function* () {
          steps.push(yield* CurrentActivity);
          adapters.push(request.adapter);
          requests.push(request);

          if (agent.hangs) {
            return yield* Effect.never;
          }

          if (author.closes && request.withPerson === true) {
            return yield* new AgentError({
              message: "claude: the person closed the session before it finished",
            });
          }

          return {
            sessionId: request.sessionId,
            output: answerFor(request),
            costUsd: Option.none<number>(),
          };
        }),
    }),
    Layer.mock(StepRunner)({}),
    Layer.succeed(ReviewerSeat, ReviewerSeat.of({ login: Effect.sync(() => people.me) })),
    Layer.succeed(Runs, Runs.of({ isActive: () => Effect.sync(() => knownRun) })),
  );

  return {
    services,
    git,
    author,
    agent,
    existing,
    remote,
    stack,
    based,
    states,
    refs,
    commits,
    merge,
    requests,
    steps,
    knowRun,
    labelsOf,
    setLabels,
    comments,
    reviews,
    adapters,
    comment,
    people,
    submitted,
    graph,
    branchPulls,
    authored,
    closing,
    plans,
    removed,
    board,
  };
};

export type Fake = ReturnType<typeof makeFake>;

export const item = (key: string, data: Json = {}): WorkItem => ({ key, data });

// A run as the engine reports it, and the stores a test may read it back from.
export type EngineRun = RunView | ActiveRun;

export type RunsServices = Layer.Success<typeof RunsLayer>;

// What a test's `until` can use while a run goes: the runs module and its runtime, to wake runs too.
export type RuntimeServices = RunsServices | Layer.Success<ReturnType<typeof runtimeFor>>;

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

// A run log that keeps nothing, for a flow's trigger run outside the engine.
const quietLog = Layer.succeed(
  RunLog,
  RunLog.of({ log: () => Effect.void, step: () => Effect.void, stepDone: () => Effect.void }),
);

// Starts a run of the flow on the fake, and polls until `until` says it has got far enough.
export const runUntil = (
  handle: FlowHandle,
  fake: Fake,
  work: WorkItem,
  until: (run: EngineRun) => Effect.Effect<boolean, never, RuntimeServices>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-steps-" });
    const platform = yield* Effect.context<BunServices.BunServices>();
    const built = yield* Layer.build(fake.services);
    const services = forEveryPersona(built);

    const releasing = Context.merge(
      platform,
      yield* Layer.build(Layer.merge(fake.services, quietLog)),
    );

    const engine = yield* Layer.build(
      RuntimeLayer({
        handles: [handle],
        services: () => Option.some(Effect.succeed(releasing)),
      }).pipe(
        Layer.provideMerge(flowLayer(handle, services)),
        Layer.provideMerge(StateAt(homePaths(home).state)),
        Layer.provideMerge(Home.at(home, home)),
      ),
    );

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
      // A run that ended has its markers released, as the daemon releases them.
      Effect.tap((polled) =>
        Effect.when(
          releaseMarkersUseCase(),
          Effect.sync(() => !isRunning(polled)),
        ),
      ),
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

// What a flow's own trigger reports on the fake.
export const flowTriggered = (fake: Fake, flow: Flow) =>
  Effect.provide(triggerOf(flow), Layer.mergeAll(fake.services, quietLog));

export const summaryOf = (run: EngineRun) => Option.getOrElse(run.summary, () => "");
