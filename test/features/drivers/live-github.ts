// What the live driver (live.ts) decides without touching GitHub, so a test
// can check it against records it makes up: whether and how it's configured,
// which login each of the cast's personas is, how GitHub's records read into
// the domain's terms, and what a scenario cleans up, never the default branch.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import YAML from "yaml";

import type { Login, PushSeen, Sequenced, World } from "../domain.ts";
import { A_PERSON, answersAReview, handsOff, issueOfBranch, reasonsOf, verdictOf } from "./cast.ts";

// How a person runs the live driver.
export const HOW_TO_RUN =
  "CHERNABOG_FEATURES_LIVE_REPO=owner/scratch CHERNABOG_FEATURES_LIVE_PERSONAS=<writer>,<reviewer> " +
  "bun test test/acceptance/review-loop.live.feature.test.ts";

// What the driver works on: a scratch repo, and the logins alice and bob act as.
export type LiveConfig = {
  readonly slug: string;
  readonly writer: Login;
  readonly reviewer: Login;
};

// Whether the environment configures the driver: not at all, as it is
// everywhere but a person's run; well; or so that it can't run, and why.
export type Configured =
  | { readonly kind: "unconfigured" }
  | { readonly kind: "configured"; readonly config: LiveConfig }
  | { readonly kind: "misconfigured"; readonly why: string };

const SLUG = /^[\w.-]+\/[\w.-]+$/;
const LOGIN = /^[A-Za-z\d](?:[A-Za-z\d-]*[A-Za-z\d])?(?:\[bot\])?$/;

const misconfigured = (why: string): Configured => ({ kind: "misconfigured", why });

// By CHERNABOG_FEATURES_LIVE_REPO and CHERNABOG_FEATURES_LIVE_PERSONAS, as `repo` and `personas`.
export const configuredBy = (
  repo: Option.Option<string>,
  personas: Option.Option<string>,
): Configured => {
  if (Option.isNone(repo) && Option.isNone(personas)) {
    return { kind: "unconfigured" };
  }

  const slug = Option.getOrElse(repo, () => "").trim();

  const logins = Option.getOrElse(personas, () => "")
    .split(",")
    .map((login) => login.trim())
    .filter((login) => login !== "");

  if (!SLUG.test(slug)) {
    return misconfigured(`CHERNABOG_FEATURES_LIVE_REPO must be owner/name: ${HOW_TO_RUN}`);
  }

  const [writer = "", reviewer = ""] = logins;

  if (logins.length !== 2 || !logins.every((login) => LOGIN.test(login)) || writer === reviewer) {
    return misconfigured(
      `CHERNABOG_FEATURES_LIVE_PERSONAS must be two different logins, the writer's then the reviewer's: ${HOW_TO_RUN}`,
    );
  }

  return { kind: "configured", config: { slug, writer, reviewer } };
};

// The cast's personas, in the order the configuration names their logins
// (cast.ts' writer first).
export const CAST: ReadonlyArray<Login> = ["alice", "bob"];

// Which login each of the cast's personas acts as, and back.
export type CastLogins = {
  readonly loginOf: (name: Login) => Option.Option<Login>;
  // A cast persona's name for its login; any other login as it is.
  readonly nameOf: (login: Login) => Login;
  // Who did something, as the world says it: a cast persona, or a person.
  readonly actorOf: (login: Option.Option<Login>) => Login;
};

export const castLogins = (config: LiveConfig): CastLogins => {
  const pairs: ReadonlyArray<readonly [Login, Login]> = [
    ["alice", config.writer],
    ["bob", config.reviewer],
  ];

  const nameOf = (login: Login) =>
    Option.getOrElse(
      Option.map(
        Arr.findFirst(pairs, ([, found]) => found.toLowerCase() === login.toLowerCase()),
        ([name]) => name,
      ),
      () => login,
    );

  return {
    loginOf: (name) =>
      Option.map(
        Arr.findFirst(pairs, ([found]) => found === name),
        ([, login]) => login,
      ),
    nameOf,
    actorOf: (login) =>
      Option.getOrElse(
        Option.filter(Option.map(login, nameOf), (name) => CAST.includes(name)),
        () => A_PERSON,
      ),
  };
};

// What the driver read from GitHub and the fake agents, for the scenario's
// issues and the pull requests on its scratch base.
export type LiveRecords = {
  readonly issues: ReadonlyArray<{
    readonly number: number;
    readonly labels: ReadonlyArray<string>;
  }>;
  readonly pulls: ReadonlyArray<{
    readonly number: number;
    readonly author: Login;
    readonly headRef: string;
    readonly headSha: string;
    readonly requested: ReadonlyArray<Login>;
    readonly mergedBy: Option.Option<Login>;
    readonly mergedAt: Option.Option<string>;
  }>;
  readonly reviews: ReadonlyArray<{
    readonly pullRequest: number;
    readonly author: Login;
    readonly state: string;
    readonly commitId: string;
    readonly submittedAt: string;
    readonly lineComments: number;
  }>;
  readonly comments: ReadonlyArray<{
    readonly pullRequest: number;
    readonly author: Login;
    readonly body: string;
    readonly createdAt: string;
  }>;
  // Each push that moved a pull request's branch, from the repo's activity.
  readonly pushes: ReadonlyArray<{
    readonly branch: string;
    readonly after: string;
    readonly actor: Option.Option<Login>;
    readonly timestamp: string;
  }>;
  readonly reviewRequests: ReadonlyArray<{
    readonly pullRequest: number;
    readonly reviewer: Login;
    readonly actor: Option.Option<Login>;
    readonly createdAt: string;
  }>;
  readonly labelled: ReadonlyArray<{
    readonly pullRequest: number;
    readonly label: string;
    readonly createdAt: string;
  }>;
  // Each call of a fake agent, as its session log has it, with the persona
  // its token was for when the driver told it the token's login.
  readonly sessions: ReadonlyArray<{
    readonly persona: Option.Option<Login>;
    readonly session: string;
    readonly resumed: boolean;
    readonly branch: string;
    readonly head: string;
    readonly at: string;
  }>;
};

// The world's one order (domain.ts' Sequenced), from the times GitHub and
// the fake agents give. GitHub gives whole seconds, so every time is taken
// to its second (the fake agents' milliseconds too), and within one second a
// kind of event goes in the order the loop makes them: an agent's session
// before the push it makes, a push before the review request that follows
// it, a review before the merge it allows.
const RANKS = {
  session: 0,
  push: 1,
  reviewRequest: 2,
  review: 3,
  reply: 4,
  handOff: 5,
  merge: 6,
} as const;

const RANKED = 10;

const SECOND = 1000;

export const sequenceAt = (at: string, kind: keyof typeof RANKS) =>
  Math.floor(Date.parse(at) / SECOND) * RANKED + RANKS[kind];

const bySequence = Order.mapInput(Order.Number, (event: Sequenced) => event.sequence);

const inOrder = <A extends Sequenced>(events: ReadonlyArray<A>) => Arr.sort(events, bySequence);

// The pull request whose head is `branch`.
const pullOn = (records: LiveRecords, branch: string) =>
  Arr.findLast(records.pulls, (pull) => pull.headRef === branch);

const pushesOf = (records: LiveRecords, cast: CastLogins): ReadonlyArray<PushSeen> =>
  inOrder(
    records.pushes.flatMap((push) =>
      Option.toArray(pullOn(records, push.branch)).map((pull) => ({
        pullRequest: pull.number,
        by: cast.actorOf(push.actor),
        head: push.after,
        sequence: sequenceAt(push.timestamp, "push"),
      })),
    ),
  );

// The pull request an agent call worked on: the one on its branch, or, on no
// branch (as a review's worktree is), the one with a push of its commit.
const sessionsOf = (records: LiveRecords, cast: CastLogins, pushes: ReadonlyArray<PushSeen>) =>
  inOrder(
    records.sessions.flatMap((call) =>
      Option.toArray(
        Option.all({
          persona: Option.map(call.persona, cast.nameOf),
          pullRequest: Option.orElse(
            Option.map(pullOn(records, call.branch), (pull) => pull.number),
            () =>
              Option.map(
                Arr.findLast(pushes, (push) => push.head === call.head),
                (push) => push.pullRequest,
              ),
          ),
        }).pipe(
          Option.map(({ persona, pullRequest }) => ({
            pullRequest,
            persona,
            session: call.session,
            resumed: call.resumed,
            sequence: sequenceAt(call.at, "session"),
          })),
        ),
      ),
    ),
  );

// What GitHub and the fake agents show, in the domain's terms.
export const worldFrom = (records: LiveRecords, cast: CastLogins): World => {
  const numbers = new Set(records.pulls.map((pull) => pull.number));
  const pushes = pushesOf(records, cast);

  return {
    issues: Arr.sort(
      records.issues,
      Order.mapInput(Order.Number, (issue: { readonly number: number }) => issue.number),
    ).map((issue) => ({ number: issue.number, labels: [...issue.labels] })),
    pullRequests: Arr.sort(
      records.pulls,
      Order.mapInput(Order.Number, (pull: { readonly number: number }) => pull.number),
    ).map((pull) => ({
      number: pull.number,
      author: cast.nameOf(pull.author),
      issue: issueOfBranch(pull.headRef),
      head: pull.headSha,
      requested: pull.requested.map(cast.nameOf),
      mergedBy: Option.map(pull.mergedBy, cast.nameOf),
    })),
    reviews: inOrder(
      records.reviews.map((review) => ({
        pullRequest: review.pullRequest,
        reviewer: cast.nameOf(review.author),
        verdict: verdictOf(review.state),
        head: review.commitId,
        lineComments: review.lineComments,
        sequence: sequenceAt(review.submittedAt, "review"),
      })),
    ),
    replies: inOrder(
      records.comments
        .filter((comment) => answersAReview(comment.body))
        .map((comment) => ({
          pullRequest: comment.pullRequest,
          author: cast.nameOf(comment.author),
          reasons: reasonsOf(comment.body),
          sequence: sequenceAt(comment.createdAt, "reply"),
        })),
    ),
    pushes,
    reviewRequests: inOrder(
      records.reviewRequests.map((asked) => ({
        pullRequest: asked.pullRequest,
        reviewer: cast.nameOf(asked.reviewer),
        by: cast.actorOf(asked.actor),
        sequence: sequenceAt(asked.createdAt, "reviewRequest"),
      })),
    ),
    handOffs: inOrder(
      records.labelled
        .filter((found) => numbers.has(found.pullRequest) && handsOff(found.label))
        .map((found) => ({
          pullRequest: found.pullRequest,
          sequence: sequenceAt(found.createdAt, "handOff"),
        })),
    ),
    sessions: sessionsOf(records, cast, pushes),
    merges: inOrder(
      records.pulls.flatMap((pull) =>
        Option.toArray(
          Option.all({ by: pull.mergedBy, at: pull.mergedAt }).pipe(
            Option.map(({ at, by }) => ({
              pullRequest: pull.number,
              by: cast.nameOf(by),
              sequence: sequenceAt(at, "merge"),
            })),
          ),
        ),
      ),
    ),
  };
};

// Every scenario's scratch base is under this, apart from anything a person keeps.
export const SCRATCH_PREFIX = "chernabog-features-live/";

export const scratchBaseFor = (id: string) => `${SCRATCH_PREFIX}${id}`;

// What a scenario leaves on GitHub, as the driver knows it when it ends.
export type Left = {
  readonly scratchBase: string;
  readonly issues: ReadonlyArray<{ readonly number: number; readonly open: boolean }>;
  readonly pulls: ReadonlyArray<{
    readonly number: number;
    readonly headRef: string;
    readonly open: boolean;
  }>;
};

// How a scenario cleans up: what it closes, then the refs it deletes, by
// their names under refs/ (heads/<branch>), and the prefixes under refs/
// whose every ref it deletes (a claim's lease refs), its scratch base last.
export type CleanupPlan = {
  readonly close: ReadonlyArray<{ readonly kind: "pull" | "issue"; readonly number: number }>;
  readonly deletePrefixes: ReadonlyArray<string>;
  readonly deleteRefs: ReadonlyArray<string>;
};

// The work items a run names for the scenario's issues and pull requests,
// as core's Claims does: issue-<n>, pr-<n>.
const itemsOf = (left: Left) => [
  ...left.issues.map((issue) => `issue-${issue.number}`),
  ...left.pulls.map((pull) => `pr-${pull.number}`),
];

export const cleanupPlan = (left: Left): CleanupPlan => {
  const items = itemsOf(left);

  return {
    close: [
      ...left.pulls.filter((pull) => pull.open).map((pull) => ({ kind: "pull" as const, ...pull })),
      ...left.issues
        .filter((issue) => issue.open)
        .map((issue) => ({ kind: "issue" as const, ...issue })),
    ].map(({ kind, number }) => ({ kind, number })),
    deletePrefixes: items.map((item) => `chernabog/leases/${item}/`),
    deleteRefs: Arr.dedupe([
      ...left.pulls.map((pull) => `heads/${pull.headRef}`),
      ...left.issues.map((issue) => `heads/auto/issue-${issue.number}`),
      ...items.map((item) => `heads/chernabog/threads/${item}`),
      ...items.map((item) => `chernabog/claims/${item}`),
      `heads/${left.scratchBase}`,
    ]),
  };
};

// The plan, if it leaves the default branch alone and its base is a scratch
// one; why not, otherwise. Nothing of it is carried out unless it passes.
export const guarded = (
  plan: CleanupPlan,
  defaultBranch: string,
): Result.Result<CleanupPlan, string> => {
  const defaultRef = `heads/${defaultBranch}`;
  const base = Arr.last(plan.deleteRefs);

  const touching = [
    ...plan.deleteRefs.filter((ref) => ref === defaultRef),
    ...plan.deletePrefixes.filter((prefix) => defaultRef.startsWith(prefix)),
  ];

  if (touching.length > 0) {
    return Result.fail(
      `the cleanup would delete ${touching.join(", ")}, the default branch ${defaultBranch}; nothing was cleaned up`,
    );
  }

  if (!Option.exists(base, (ref) => ref.startsWith(`heads/${SCRATCH_PREFIX}`))) {
    return Result.fail(
      `the cleanup's base isn't a scratch branch under ${SCRATCH_PREFIX}; nothing was cleaned up`,
    );
  }

  return Result.succeed(plan);
};

// Whether a branch is one the scenario may create or push to: a scratch base,
// never the default branch.
export const mayCreate = (branch: string, defaultBranch: string) =>
  branch !== defaultBranch && branch.startsWith(SCRATCH_PREFIX);

const Logins = Schema.OptionFromOptionalKey(Schema.Array(Schema.String));

// The reviewer pool in the team's config.
const TeamPool = Schema.Struct({
  settings: Schema.OptionFromOptionalKey(Schema.Struct({ reviewers: Logins })),
  reviewers: Logins,
});

// What keeps the team's config on the default branch from running the cast:
// its reviewer pool (settings.reviewers, or the deprecated reviewers) must
// hold each login the scenario has review.
export const poolProblems = (
  configYaml: string,
  reviewing: ReadonlyArray<Login>,
): ReadonlyArray<string> => {
  const pool = Result.match(Schema.decodeUnknownResult(TeamPool)(YAML.parse(configYaml)), {
    onFailure: () => new Set<string>(),
    onSuccess: (config) =>
      new Set(
        [
          ...Option.getOrElse(
            Option.flatMap(config.settings, (settings) => settings.reviewers),
            () => [],
          ),
          ...Option.getOrElse(config.reviewers, () => []),
        ].map((login) => login.toLowerCase()),
      ),
  });

  return reviewing.flatMap((login) =>
    Option.toArray(
      Option.liftPredicate(
        `${login} isn't in .chernabog/config.yaml's settings.reviewers`,
        () => !pool.has(login.toLowerCase()),
      ),
    ),
  );
};
