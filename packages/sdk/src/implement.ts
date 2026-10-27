// The building blocks of the `implement` recipe: find a queued issue,
// claim it, prepare a worktree, let the agent implement it, run the local gate,
// open the pull request, wait for CI and hand off for review. Each block is an
// activity, so a flow can reorder them, leave one out, or put its own step
// from .chernabog/stages/ in between.

import { createHash } from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Claims from "./claims.ts";
import { ADDRESS, CONSIDER } from "./default-prompts.ts";
import { CiTimedOut, NeedsHuman, NothingCommitted, Skip, StepFailed } from "./errors.ts";
import { activity, reportAs, sleep } from "./flow.ts";
import type { Json } from "./json.ts";
import { type ClaimMarker, claimMarker, latestMarker, sessionMarker } from "./markers.ts";
import { pathsMatching } from "./paths.ts";
import { renderPrompt, renderPromptOr } from "./prompt.ts";
import { requestReview } from "./pull-request.ts";
import type { ReviewResult } from "./review.ts";
import {
  Agent,
  type AgentResult,
  Git,
  GitHub,
  type Issue,
  Repo,
  Run,
  RunLog,
  Usage,
  type WorkItem,
  Worktree,
} from "./services.ts";

export const branchFor = (issue: number) => `auto/issue-${issue}`;

// An issue to implement, and the label that queued it, when it's not eligible's.
export const IssueItem = Schema.Struct({
  issue: Schema.Finite,
  label: Schema.optionalKey(Schema.String),
});

export const issueItem = (
  issue: Issue,
  label: Option.Option<string> = Option.none(),
): WorkItem => ({
  key: `issue-${issue.number}`,
  title: issue.title,
  url: issue.url,
  data: {
    issue: issue.number,
    ...Option.match(label, { onNone: () => ({}), onSome: (queued) => ({ label: queued }) }),
  },
  assignees: issue.assignees,
});

// The issue number a work item from `trigger` carries.
export const issueOf = (item: WorkItem) =>
  Schema.decodeUnknownEffect(IssueItem)(item.data).pipe(
    Effect.map((data) => data.issue),
    Effect.mapError(
      (issue) =>
        new StepFailed({
          step: "work item",
          message: `${item.key} is not an issue: ${issue.message}`,
        }),
    ),
  );

// A stable session id per run and purpose, so a rerun after a crash resumes
// the agent's session instead of starting over.
export const sessionIdFor = (runId: string, purpose: string) => {
  const hex = createHash("sha256").update(`${runId}/${purpose}`).digest("hex");
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

// Issues with a queue label, oldest first, each with its assignees. A flow
// keyed by its own label pairs it with `claim(issue, queuedBy(item))`.
export const triggerFor = (label: string) =>
  GitHub.use((github) => github.queuedIssuesLabelled(label)).pipe(
    Effect.map((issues) => issues.map((issue) => issueItem(issue, Option.some(label)))),
    reportAs("trigger"),
  );

// Which label queued the issue: eligible unless the flow is keyed by its own.
export type QueueOptions = { readonly label?: string };

// The label that queued a work item from `trigger`, for claim,
// askForClarification and openPullRequest.
export const queuedBy = (item: WorkItem) =>
  Schema.decodeUnknownEffect(IssueItem)(item.data).pipe(
    Effect.map((data): QueueOptions =>
      Option.match(Option.fromUndefinedOr(data.label), {
        onNone: () => ({}),
        onSome: (label) => ({ label }),
      }),
    ),
    Effect.mapError(
      (issue) =>
        new StepFailed({
          step: "work item",
          message: `${item.key} is not an issue: ${issue.message}`,
        }),
    ),
  );

const queueLabel = (options: QueueOptions) =>
  Repo.use((repo) => Effect.succeed(options.label ?? repo.labels.eligible));

// The account is the one machine config expects, and it has room for a task.
export const gate = Effect.gen(function* () {
  const usage = yield* Usage;
  yield* usage.checkAccount;
  const decision = yield* usage.gate;

  if (!decision.launch) {
    return yield* new Skip({ reason: `usage gate: ${decision.reason}` });
  }
}).pipe(reportAs("gate"));

// Issues are often public, so the comment says nothing about the machine: no
// hostname, and no worktree path with the user's home in it.
export const claimComment = (claim: ClaimMarker) =>
  [
    `Claimed by Chernabog at ${claim.claimedAt}, on branch \`${claim.branch}\`.`,
    "",
    `- Run: \`${claim.runId}\``,
    "",
    claimMarker.write(claim),
  ].join("\n");

// The latest claim marker on the issue, from its comments.
export const latestClaim = (issue: number) =>
  GitHub.use((github) => github.comments(issue)).pipe(
    Effect.map((comments) =>
      latestMarker(
        claimMarker.read,
        comments.map((comment) => comment.body),
      ),
    ),
  );

// Migration: a run of an earlier version holds an issue by its branch alone,
// and its claim marker names no claim ref. While such runs may be in flight,
// an existing branch whose latest marker is one of theirs is still theirs.
// Drop this a release after claims became refs.
export const legacyClaim = (latest: Option.Option<ClaimMarker>, runId: string) =>
  Option.filter(latest, (marker) => marker.ref !== true && marker.runId !== runId);

// Claims the issue with its claim ref, which only one run can create, then
// creates the issue's branch, or adopts one with no claim on it, and labels,
// assigns and comments as a person picking it up would. Safe to repeat: a run
// that already holds the claim keeps it. Removes the label that queued the
// issue. Wrap the run in `Claims.releasing(Claims.issue(issue))` to let the
// claim go when it ends.
export const claim = (issue: number, options: QueueOptions = {}) =>
  activity(
    "claim",
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      const run = yield* Run;
      const label = yield* queueLabel(options);
      const branch = branchFor(issue);
      const item = Claims.issue(issue);
      const baseSha = yield* github.branchSha(repo.baseBranch);

      if (Option.isNone(baseSha)) {
        return yield* new StepFailed({
          step: "claim",
          message: `base branch ${repo.baseBranch} not found`,
        });
      }

      const claimed = yield* Claims.acquire(item);

      if (!claimed.acquired) {
        return yield* new Skip({
          reason: `#${issue} is already claimed (${Claims.describeHolder(item, claimed.holder)})`,
        });
      }

      if ((yield* github.createBranch(branch, baseSha.value)) === "already-exists") {
        const latest = yield* latestClaim(issue);

        if (Option.exists(latest, (marker) => marker.runId === run.runId)) {
          return { branch };
        }

        if (Option.isSome(legacyClaim(latest, run.runId))) {
          yield* Claims.release(item);

          return yield* new Skip({ reason: `#${issue} is already claimed (${branch} exists)` });
        }
      }

      yield* github.addLabel(issue, repo.labels.inProgress);
      yield* github.removeLabel(issue, label);

      if (Option.isSome(repo.board)) {
        yield* github.moveToStatus(issue, repo.board.value.inProgressStatus);
      }

      yield* github.assignSelf(issue);
      const claimedAt = DateTime.formatIso(yield* DateTime.now);
      yield* github.comment(
        issue,
        claimComment({ runId: run.runId, claimedAt, branch, ref: true }),
      );

      return { branch };
    }),
    Schema.Struct({ branch: Schema.String }),
  );

// Runs a repo command, such as the install or a local gate check, and keeps
// what it printed, stdout and stderr interleaved.
export const shell = (command: string, cwd: string, env: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const handle = yield* spawner.spawn(
      ChildProcess.make("sh", ["-c", command], {
        cwd,
        env: { ...env, CI: "1" },
        extendEnv: true,
        forceKillAfter: "5 seconds",
      }),
    );

    const [output, exitCode] = yield* Effect.all(
      [Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode],
      { concurrency: "unbounded" },
    );

    return { exitCode: Number(exitCode), output };
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) => new StepFailed({ step: command, message: error.message })),
  );

const tail = (text: string, lines = 80) => text.trimEnd().split("\n").slice(-lines).join("\n");

// The worktree for the claim branch, with dependencies installed.
export const prepareWorktree = (branch: string) =>
  activity(
    "prepare-worktree",
    Effect.gen(function* () {
      const repo = yield* Repo;
      const path = yield* (yield* Worktree).ensure(branch);

      if (Option.isSome(repo.install)) {
        const installed = yield* shell(repo.install.value, path, repo.env);

        if (installed.exitCode !== 0) {
          return yield* new StepFailed({ step: "install", message: tail(installed.output, 30) });
        }
      }

      return path;
    }),
    Schema.String,
  );

export const ImplementOutcome = Schema.Struct({
  status: Schema.Literals(["done", "needs-clarification"]),
  summary: Schema.String,
  title: Schema.String,
  body: Schema.String,
  questions: Schema.optionalKey(Schema.String),
});

export type ImplementOutcome = typeof ImplementOutcome.Type;

export const implementOutcomeJsonSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["done", "needs-clarification"] },
    summary: {
      type: "string",
      description: "What changed and how it was tested, for the issue comment",
    },
    title: {
      type: "string",
      description: "The pull request title, following the repo commit convention",
    },
    body: {
      type: "string",
      description: "The pull request body in Markdown, without the Closes line",
    },
    questions: {
      type: "string",
      description: "For needs-clarification: numbered questions, each led by a recommendation",
    },
  },
  required: ["status", "summary", "title", "body"],
  additionalProperties: false,
} satisfies Json;

const RESUME_PROMPT =
  "You were interrupted. Continue the task from where you left off, then give your final answer in the required format.";

const decodeOutcome = (result: AgentResult) =>
  Schema.decodeUnknownEffect(ImplementOutcome)(result.output).pipe(
    Effect.mapError(
      (issue) => new StepFailed({ step: "agent", message: `agent answer: ${issue.message}` }),
    ),
  );

// The agent implements the issue in the worktree and commits, from
// .chernabog/prompts/implement.md. It answers done, with the pull request's
// title and body, or needs-clarification, with its questions.
export const implementWithAgent = (issue: number, worktree: string) =>
  activity(
    "implement",
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      const run = yield* Run;
      const details = yield* github.issue(issue);
      const comments = yield* github.trustedComments(issue);

      const prompt = yield* renderPrompt("implement", {
        repo: repo.slug,
        issue,
        title: details.title,
        body: details.body,
        comments: comments.map((comment) => `${comment.author}: ${comment.body}`),
        branch: branchFor(issue),
        base: repo.baseBranch,
        localGate: repo.localGate.map((command) => `\`${command}\``),
        humanOnly: repo.humanOnly,
        notes: repo.notes,
      });

      const result = yield* (yield* Agent).run({
        cwd: worktree,
        prompt,
        sessionId: sessionIdFor(run.runId, "implement"),
        resumePrompt: Option.some(RESUME_PROMPT),
        outputSchema: Option.some(implementOutcomeJsonSchema),
        adapter: Option.none(),
      });

      return yield* decodeOutcome(result);
    }),
    ImplementOutcome,
  );

// Which session a fix goes to: this run's implement session when none is
// given. withPerson: a person works in it with the agent, on the hybrid path.
export type AuthorSession = {
  readonly sessionId: Option.Option<string>;
  readonly adapter: Option.Option<string>;
  readonly withPerson?: boolean;
};

export const thisRunsSession: AuthorSession = { sessionId: Option.none(), adapter: Option.none() };

// Sends the agent back into its session with a failure to fix.
export const fixWithAgent = (
  name: string,
  worktree: string,
  prompt: string,
  session: AuthorSession,
) =>
  activity(
    name,
    Effect.gen(function* () {
      const run = yield* Run;

      const result = yield* (yield* Agent).run({
        cwd: worktree,
        prompt,
        sessionId: Option.getOrElse(session.sessionId, () => sessionIdFor(run.runId, "implement")),
        resumePrompt: Option.some(prompt),
        outputSchema: Option.some(implementOutcomeJsonSchema),
        adapter: session.adapter,
        withPerson: session.withPerson === true,
      });

      return yield* decodeOutcome(result);
    }),
    ImplementOutcome,
  );

// The review's findings for a prompt: its summary, then each line comment.
const describeReview = (review: ReviewResult) =>
  [
    review.summary ?? `The review's verdict was ${review.verdict}.`,
    ...(review.comments ?? []).map(
      (comment) => `- ${comment.path}:${comment.line}: ${comment.body}`,
    ),
  ].join("\n\n");

export const Consideration = Schema.Struct({
  status: Schema.Literals(["address", "decline"]),
  reasons: Schema.String,
});

export type Consideration = typeof Consideration.Type;

export const considerationJsonSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["address", "decline"] },
    reasons: { type: "string", description: "Why, point by point, in Markdown" },
  },
  required: ["status", "reasons"],
  additionalProperties: false,
} satisfies Json;

const authorWorktree = (pullRequest: number) =>
  Effect.gen(function* () {
    const pull = yield* (yield* GitHub).pullRequest(pullRequest);

    return yield* (yield* Worktree).ensure(pull.headRef);
  });

// Resumes the author's session with a review, and asks whether to address it
// or decline it, with reasons. Changes nothing. Its prompt is
// .chernabog/prompts/consider.md, or the SDK's own.
export const considerFindings = (
  pullRequest: number,
  review: ReviewResult,
  session: AuthorSession,
) => {
  const round = review.round ?? 1;

  return activity(
    `consider-review-${round}`,
    Effect.gen(function* () {
      const run = yield* Run;
      const worktree = yield* authorWorktree(pullRequest);

      const prompt = yield* renderPromptOr("consider", CONSIDER, {
        pullRequest,
        round,
        review: describeReview(review),
      });

      const result = yield* (yield* Agent).run({
        cwd: worktree,
        prompt,
        sessionId: Option.getOrElse(session.sessionId, () => sessionIdFor(run.runId, "implement")),
        resumePrompt: Option.some(prompt),
        outputSchema: Option.some(considerationJsonSchema),
        adapter: session.adapter,
        withPerson: session.withPerson === true,
      });

      return yield* Schema.decodeUnknownEffect(Consideration)(result.output).pipe(
        Effect.mapError(
          (issue) =>
            new StepFailed({
              step: `consider-review-${round}`,
              message: `agent answer: ${issue.message}`,
            }),
        ),
      );
    }),
    Consideration,
  );
};

// Resumes the author's session to make the changes a review asks for, and
// commit them, as fixWithAgent does for a failing check. Its prompt is
// .chernabog/prompts/address.md, or the SDK's own.
export const addressFindings = (
  pullRequest: number,
  review: ReviewResult,
  session: AuthorSession,
) =>
  Effect.gen(function* () {
    const round = review.round ?? 1;

    const prepared = yield* activity(
      `prepare-address-${round}`,
      Effect.gen(function* () {
        const worktree = yield* authorWorktree(pullRequest);

        const prompt = yield* renderPromptOr("address", ADDRESS, {
          pullRequest,
          round,
          review: describeReview(review),
        });

        return { worktree, prompt };
      }),
      Schema.Struct({ worktree: Schema.String, prompt: Schema.String }),
    );

    return yield* fixWithAgent(
      `address-review-${round}`,
      prepared.worktree,
      prepared.prompt,
      session,
    );
  });

const requeueHint = (board: Option.Option<{ readonly readyStatus: string }>) =>
  Option.match(board, {
    onNone: () => "apply",
    onSome: (found) => `set Status back to ${found.readyStatus} and apply`,
  });

// Posts the agent's questions, releases the claim and stops, as a person would
// who needs an answer before going on. The requeue hint names the label that queued it.
export const askForClarification = (
  issue: number,
  outcome: ImplementOutcome,
  options: QueueOptions = {},
) =>
  activity(
    "needs-clarification",
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      const label = yield* queueLabel(options);
      const questions = outcome.questions ?? outcome.summary;
      yield* github.comment(
        issue,
        [
          questions,
          "",
          `To requeue: answer the questions above, then ${requeueHint(repo.board)} \`${label}\` again.`,
        ].join("\n"),
      );
      yield* github.addLabel(issue, repo.labels.needsClarification);
      yield* github.removeLabel(issue, repo.labels.inProgress);
      yield* github.deleteBranch(branchFor(issue));
      yield* (yield* Worktree).remove(branchFor(issue));

      return `#${issue} needs clarification`;
    }),
    Schema.String,
  );

const LocalGateResult = Schema.Struct({ ok: Schema.Boolean, failure: Schema.String });

// Tells apart two calls of a looping step in one run, such as the local gate
// before the pull request opens and again after a review's fix: their
// activities are named like `local-gate-1#fix-1`, as `step` does with its id.
export type RepeatOptions = { readonly id?: string };

// The session the local gate sends the agent back to: this run's implement session unless given.
export type LocalGateOptions = RepeatOptions & { readonly session?: AuthorSession };

const named = (options: RepeatOptions, name: string) =>
  Option.match(Option.fromUndefinedOr(options.id), {
    onNone: () => name,
    onSome: (id) => `${name}#${id}`,
  });

const runLocalGate = (worktree: string, round: number, options: RepeatOptions) =>
  activity(
    named(options, `local-gate-${round}`),
    Effect.gen(function* () {
      const repo = yield* Repo;
      const log = yield* RunLog;

      for (const command of repo.localGate) {
        yield* log.log(`local gate: ${command}`);
        const result = yield* shell(command, worktree, repo.env);

        if (result.exitCode !== 0) {
          return {
            ok: false,
            failure: `\`${command}\` exited ${result.exitCode}:\n\n${tail(result.output)}`,
          };
        }
      }

      return { ok: true, failure: "" };
    }),
    LocalGateResult,
  );

// Runs the repo's local gate, and sends the agent back to fix what fails, up to
// limits.localGateRounds times.
export const localGate = (worktree: string, options: LocalGateOptions = {}) =>
  Effect.gen(function* () {
    const repo = yield* Repo;

    for (let round = 1; ; round++) {
      const result = yield* runLocalGate(worktree, round, options);

      if (result.ok) {
        return;
      }

      if (round > repo.limits.localGateRounds) {
        return yield* new NeedsHuman({
          reason: `the local gate still fails after ${repo.limits.localGateRounds} fix attempts:\n\n${result.failure}`,
        });
      }

      yield* fixWithAgent(
        named(options, `fix-local-gate-${round}`),
        worktree,
        `The local gate failed. Fix the cause, commit, and answer again.\n\n${result.failure}`,
        options.session ?? thisRunsSession,
      );
    }
  });

// withPerson: a person is in the session that wrote the change, so it may
// touch humanOnlyPaths; a person still merges it (PullRequest.merge checks them again).
export type PushOptions = { readonly withPerson?: boolean };

// Checks the branch has commits and, unless a person is in the session,
// touches no human-only paths, and pushes it. Fails with NothingCommitted when
// there's nothing to push, and PushRejected when the remote refuses it, such
// as for a token without the workflow scope.
export const push = (name: string, worktree: string, branch: string, options: PushOptions = {}) =>
  activity(
    name,
    Effect.gen(function* () {
      const git = yield* Git;
      const repo = yield* Repo;

      if ((yield* git.commitsAhead(worktree, repo.baseBranch)) === 0) {
        return yield* new NothingCommitted({ branch });
      }

      if (options.withPerson !== true) {
        const touched = pathsMatching(
          yield* git.changedFiles(worktree, repo.baseBranch),
          repo.humanOnlyPaths,
        );

        if (touched.length > 0) {
          return yield* new NeedsHuman({
            reason: `the change touches paths a person must handle: ${touched.map((path) => `\`${path}\``).join(", ")}`,
          });
        }
      }

      yield* git.push(worktree, branch);
    }),
  );

export const PullRequestRef = Schema.Struct({ number: Schema.Finite, url: Schema.String });

export type PullRequestRef = typeof PullRequestRef.Type;

const footer = (shipping: boolean) => {
  if (shipping) {
    return "Opened by Chernabog for an unattended run, on the automated path: it merges once its review approves.";
  }

  return "Opened by Chernabog for an unattended run. A person merges.";
};

// Opens the pull request for the branch, or finds the one already open. An
// issue queued by ship (auto:ship) gives its pull request the label too, the
// automated path, which merges once approved.
export const openPullRequest = (
  issue: number,
  outcome: ImplementOutcome,
  options: QueueOptions = {},
) =>
  activity(
    "open-pull-request",
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      const branch = branchFor(issue);
      const shipping = options.label === repo.labels.ship;

      const existing = Option.filter(
        yield* github.pullRequestForBranch(branch),
        (pull) => pull.state === "open",
      );

      const opened = yield* Option.match(existing, {
        onSome: Effect.succeed,
        onNone: () =>
          github.openPullRequest({
            head: branch,
            base: repo.baseBranch,
            title: outcome.title,
            body: `Closes #${issue}\n\n${outcome.body}\n\n---\n${footer(shipping)}`,
          }),
      });

      if (shipping) {
        yield* github.addLabel(opened.number, repo.labels.ship);
      }

      return { number: opened.number, url: opened.url };
    }),
    PullRequestRef,
  );

const CI_POLL = Duration.minutes(1);

const CiReading = Schema.Union([
  Schema.Struct({ state: Schema.Literal("pending"), waitingOn: Schema.Array(Schema.String) }),
  Schema.Struct({ state: Schema.Literal("green") }),
  Schema.Struct({ state: Schema.Literal("red"), failedChecks: Schema.Array(Schema.String) }),
]);

type CiReading = typeof CiReading.Type;

// Polls the pull request's checks durably until they stop pending, or limits.ciTimeout passes.
const awaitChecks = (pullRequest: number, round: number, options: RepeatOptions) =>
  Effect.gen(function* () {
    const repo = yield* Repo;

    const maxPolls = Math.max(
      1,
      Math.ceil(Duration.toMillis(repo.limits.ciTimeout) / Duration.toMillis(CI_POLL)),
    );

    let reading: CiReading = { state: "pending", waitingOn: [] };

    for (let poll = 1; reading.state === "pending"; poll++) {
      if (poll > maxPolls) {
        return yield* new CiTimedOut({
          pullRequest,
          after: Duration.format(Duration.fromInputUnsafe(repo.limits.ciTimeout)),
        });
      }

      if (poll > 1) {
        yield* sleep(named(options, `ci-${round}-wait-${poll}`), CI_POLL);
      }

      reading = yield* activity(
        named(options, `ci-${round}-${poll}`),
        GitHub.use((github) => github.ciState(pullRequest)),
        CiReading,
      );
    }

    return reading;
  });

export type CiBranch = AuthorSession & { readonly branch: string };

// Waits durably for the pull request's checks. On red, the agent reads the
// failure, fixes, commits, and the branch is pushed again, up to
// limits.ciRounds times. Fails with CiTimedOut when the checks stay pending
// past limits.ciTimeout, and as push does for a fix it can't push.
export const waitForCi = (
  pullRequest: number,
  worktree: string,
  target: CiBranch,
  options: RepeatOptions = {},
) =>
  Effect.gen(function* () {
    const repo = yield* Repo;

    for (let round = 1; ; round++) {
      const reading = yield* awaitChecks(pullRequest, round, options);

      if (reading.state !== "red") {
        return;
      }

      const failed = reading.failedChecks.join(", ");

      if (round > repo.limits.ciRounds) {
        return yield* new NeedsHuman({
          reason: `CI is still red after ${repo.limits.ciRounds} fix attempts: ${failed}`,
        });
      }

      yield* fixWithAgent(
        named(options, `fix-ci-${round}`),
        worktree,
        [
          `CI failed on pull request #${pullRequest}: ${failed}.`,
          `Read why with \`gh run list --branch ${target.branch} --limit 5\` and \`gh run view <run id> --log-failed\`.`,
          "Fix the cause and commit. A failure unrelated to your change may be re-run once with `gh run rerun <run id> --failed`. Then answer again.",
        ].join("\n"),
        target,
      );
      yield* push(named(options, `push-ci-${round}`), worktree, target.branch, {
        withPerson: target.withPerson === true,
      });
    }
  });

const askForReview = (pullRequest: number, options: HandOffOptions) => {
  if (options.needsReview) {
    return requestReview(pullRequest).pipe(Effect.asVoid);
  }

  return Effect.void;
};

// Whether hand-off asks the team's reviewer pool for a review. A flow that
// reviews the pull request itself says false.
export type HandOffOptions = { readonly needsReview: boolean };

// Hands the green pull request to review: the review trigger if the repo has
// one, a review requested of one reviewer from the pool (needs-review for a
// person without one) unless the options leave it off, and a closing comment
// on the issue.
export const handOff = (
  issue: number,
  pullRequest: PullRequestRef,
  outcome: ImplementOutcome,
  options: HandOffOptions = { needsReview: true },
) =>
  activity(
    "hand-off",
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      const run = yield* Run;

      if (Option.isSome(repo.reviewTrigger)) {
        yield* github.comment(pullRequest.number, repo.reviewTrigger.value);
      }

      // The fix flow resumes this session to answer a review.
      const session = {
        adapter: repo.agent,
        sessionId: sessionIdFor(run.runId, "implement"),
        issue,
        branch: branchFor(issue),
      };

      yield* github.comment(
        pullRequest.number,
        `Implemented by ${repo.agent} for #${issue}. ${sessionMarker.write(session)}`,
      );

      yield* github.removeLabel(issue, repo.labels.inProgress);
      yield* github.comment(
        issue,
        `Pull request ready for review: ${pullRequest.url}\n\n${outcome.summary}`,
      );

      return `#${issue}: ${pullRequest.url} is ready for review`;
    }),
    Schema.String,
  ).pipe(Effect.tap(() => askForReview(pullRequest.number, options)));

// Labels the work item for a person and says why. No flow picks it up again.
export const handToHuman = (issue: number, reason: string, pullRequest: Option.Option<number>) =>
  activity(
    "needs-human",
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      yield* github.addLabel(issue, repo.labels.needsHuman);
      yield* github.removeLabel(issue, repo.labels.inProgress);

      if (Option.isSome(pullRequest)) {
        yield* github.addLabel(pullRequest.value, repo.labels.needsHuman);
      }

      yield* github.comment(
        issue,
        `Chernabog stopped and needs a person: ${reason}\n\nThe branch \`${branchFor(issue)}\` and its worktree are left as they are.`,
      );

      return `#${issue} needs a person: ${reason}`;
    }),
    Schema.String,
  );

// Ends the run as waiting on a person, once the issue says why.
export const endForPerson = (summary: string) => Effect.fail(new NeedsHuman({ reason: summary }));
