// The building blocks of the hybrid path, which chernabog's human-initiated
// recipe composes. A person hands
// chernabog an issue with `chernabog start`, and plans and implements it with
// the agent in an interactive session in front of them (workWithPerson).
// `chernabog open-pr`, run from that session, ends it; the flow then runs the
// local gate, pushes, opens the pull request (openPullRequest), waits for CI
// and asks a reviewer from the pool (handOff). review, address-review and
// re-review follow, with the person at the decisions: answering a review
// reopens their session, and only a person merges, since the pull request
// isn't on the automated path (auto:ship).

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Claims from "./claims.ts";
import { HUMAN_INITIATED } from "./default-prompts.ts";
import { Skip, StepFailed } from "./errors.ts";
import { activity, reportAs } from "./flow.ts";
import * as GitHubMarkers from "./github-markers.ts";
import {
  type AuthorSession,
  branchFor,
  dropInProgress,
  issueItem,
  latestClaim,
  legacyClaim,
  markClaimed,
  PullRequestRef,
  sessionIdFor,
} from "./implement.ts";
import type { Json } from "./json.ts";
import { claimMarker, sessionMarker } from "./markers.ts";
import { renderPromptOr } from "./prompt.ts";
import { requestReview } from "./pull-request.ts";
import * as Markers from "./run-markers.ts";
import { Agent, GitHub, Repo, Run, type WorkItem } from "./services.ts";

// Finds nothing, on whatever schedule it is given.
/** @deprecated Leave `trigger` out instead: a flow with `item` and no trigger is manual, and runs only when a person names its work. */
export const trigger = Effect.succeed<ReadonlyArray<WorkItem>>([]);

const ISSUE_KEY = /^issue-(\d+)$/;

// The issue a person names, as `issue-<number>`, whatever its labels; none for one GitHub doesn't have.
export const itemFor = (key: string) =>
  Option.match(Option.fromNullishOr(ISSUE_KEY.exec(key)), {
    onNone: () => Effect.succeedNone,
    onSome: (match) =>
      GitHub.use((github) => github.issue(Number(match[1]))).pipe(
        Effect.map((issue) => Option.some(issueItem(issue))),
        Effect.catchTag("NotFound", () => Effect.succeedNone),
        reportAs("item"),
      ),
  });

// One session per issue, whichever run opens it, so starting an issue again picks up the conversation.
const sessionIdOf = (issue: number) =>
  Repo.use((repo) => Effect.succeed(sessionIdFor(`${repo.slug}#${issue}`, "human-initiated")));

// The person's session, as the steps that send the agent back to it name it.
export const personSession = (issue: number) =>
  Effect.gen(function* () {
    const repo = yield* Repo;

    return {
      sessionId: Option.some(yield* sessionIdOf(issue)),
      adapter: Option.some(repo.agent),
      withPerson: true,
    } satisfies AuthorSession;
  });

const claimComment = (claimedAt: string, branch: string, runId: string) =>
  [
    `Started by a person with Chernabog at ${claimedAt}, on branch \`${branch}\`.`,
    "",
    `- Run: \`${runId}\``,
    "",
    claimMarker.write({ runId, claimedAt, branch, withPerson: true, ref: true }),
  ].join("\n");

// How to let go of the claim another run holds: cancelling it, which for a run
// that has ended deletes only the claim ref its flow left.
const cancelHint = (holder: Option.Option<Claims.Holder>) =>
  Option.match(holder, {
    onNone: () => "`chernabog cancel` the run that holds it",
    onSome: (found) => `\`chernabog cancel ${found.runId}\``,
  });

// Claims the issue with its claim ref, then creates the issue's branch, or
// takes up one an earlier start or an ended run left, and labels, assigns and
// comments as claim does, holding the same markers. It takes the issue out of
// the unattended queues. An issue another run holds is left to it.
export const claim = (issue: number) =>
  activity(
    "claim",
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      const run = yield* Run;
      const branch = branchFor(issue);
      const item = Claims.issue(issue);
      const baseSha = yield* github.branchSha(repo.baseBranch);

      if (Option.isNone(baseSha)) {
        return yield* new StepFailed({
          step: "claim",
          message: `base branch ${repo.baseBranch} not found`,
        });
      }

      const claimed = yield* Claims.acquire(item, { withPerson: true });

      if (!claimed.acquired) {
        return yield* new Skip({
          reason: `#${issue} is already claimed (${Claims.describeHolder(item, claimed.holder)}); ${cancelHint(claimed.holder)} to start it here`,
        });
      }

      if ((yield* github.createBranch(branch, baseSha.value)) === "already-exists") {
        const latest = yield* latestClaim(issue);

        if (Option.exists(latest, (marker) => marker.runId === run.runId)) {
          return { branch };
        }

        // An earlier start that held it by its branch alone is taken over, as before claim refs.
        if (Option.exists(legacyClaim(latest, run.runId), (marker) => marker.withPerson !== true)) {
          yield* Claims.release(item);

          return yield* new Skip({
            reason: `#${issue} is already claimed by an unattended run (${branch} exists)`,
          });
        }
      } else {
        yield* Markers.hold(GitHubMarkers.claimBranch, { branch }, { keepOn: ["needs-human"] });
      }

      // A person's session that fails, as one they close does, leaves the
      // issue in progress for their next start.
      yield* markClaimed(issue, { keepOn: ["failed"] });

      for (const queued of [repo.labels.eligible, repo.labels.ship]) {
        yield* github.removeLabel(issue, queued);
      }

      yield* github.comment(
        issue,
        claimComment(DateTime.formatIso(yield* DateTime.now), branch, run.runId),
      );

      return { branch };
    }),
    Schema.Struct({ branch: Schema.String }),
  );

// What `chernabog open-pr` records when the person and the agent are done.
export const Finished = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  summary: Schema.String,
});

export type Finished = typeof Finished.Type;

export const finishedJsonSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "The pull request title, following the repo commit convention",
    },
    body: {
      type: "string",
      description: "The pull request body in Markdown, without the Closes line",
    },
    summary: {
      type: "string",
      description: "What changed and how it was tested, for the issue comment",
    },
  },
  required: ["title", "body", "summary"],
  additionalProperties: false,
} satisfies Json;

const RESUME_PROMPT =
  "You are back in your session on this issue, with the person. Pick up where the two of you left off; when you are both done, draft the pull request with `chernabog open-pr --draft` and ask the person, as before.";

// The person and the agent work on the issue in a session in front of the
// person, until the person's Yes to the agent's draft (or their own
// `chernabog open-pr`) records the pull request's title, body and summary. Its prompt is .chernabog/prompts/human-initiated.md, or the SDK's own.
export const workWithPerson = (issue: number, worktree: string) =>
  activity(
    "work-with-person",
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      const details = yield* github.issue(issue);
      const comments = yield* github.trustedComments(issue);

      const prompt = yield* renderPromptOr("human-initiated", HUMAN_INITIATED, {
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
        sessionId: yield* sessionIdOf(issue),
        resumePrompt: Option.some(RESUME_PROMPT),
        outputSchema: Option.some(finishedJsonSchema),
        adapter: Option.none(),
        withPerson: true,
      });

      return yield* Schema.decodeUnknownEffect(Finished)(result.output).pipe(
        Effect.mapError(
          (invalid) =>
            new StepFailed({
              step: "work-with-person",
              message: `open-pr answer: ${invalid.message}`,
            }),
        ),
      );
    }),
    Finished,
  );

// Opens the pull request for the branch, or finds the one already open, and
// labels it hybrid for people reading GitHub. It never carries ship, so a
// person merges it.
export const openPullRequest = (issue: number, finished: Finished) =>
  activity(
    "open-pull-request",
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;
      const branch = branchFor(issue);

      const existing = Option.filter(
        yield* github.pullRequestForBranch(branch),
        (pull) => pull.state === "open",
      );

      const footer = `Opened by Chernabog for a person who worked on it with ${repo.agent}, on the hybrid path. A person merges.`;

      const opened = yield* Option.match(existing, {
        onSome: Effect.succeed,
        onNone: () =>
          github.openPullRequest({
            head: branch,
            base: repo.baseBranch,
            title: finished.title,
            body: `Closes #${issue}\n\n${finished.body}\n\n---\n${footer}`,
          }),
      });

      yield* github.addLabel(opened.number, repo.labels.hybrid);

      return { number: opened.number, url: opened.url };
    }),
    PullRequestRef,
  );

// Hands the green pull request to review, as Implement.handOff does: the
// session marker, so answering a review reopens the person's session, the
// review trigger if the repo has one, a comment on the issue, and a review
// asked of one reviewer from the pool.
export const handOff = (issue: number, pullRequest: PullRequestRef, finished: Finished) =>
  activity(
    "hand-off",
    Effect.gen(function* () {
      const github = yield* GitHub;
      const repo = yield* Repo;

      if (Option.isSome(repo.reviewTrigger)) {
        yield* github.comment(pullRequest.number, repo.reviewTrigger.value);
      }

      const session = {
        adapter: repo.agent,
        sessionId: yield* sessionIdOf(issue),
        issue,
        branch: branchFor(issue),
        withPerson: true,
      };

      yield* github.comment(
        pullRequest.number,
        `Worked on by a person with ${repo.agent} for #${issue}. ${sessionMarker.write(session)}`,
      );
      yield* dropInProgress(issue);
      yield* github.comment(
        issue,
        `Pull request ready for review: ${pullRequest.url}\n\n${finished.summary}`,
      );

      return `#${issue}: ${pullRequest.url} is ready for review; a person merges`;
    }),
    Schema.String,
  ).pipe(Effect.tap(() => requestReview(pullRequest.number)));
