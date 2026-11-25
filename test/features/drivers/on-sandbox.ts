// What the drivers over openSandbox (test/acceptance/sandbox.ts) share: the
// sandbox driver, which runs the cast on a daemon, and the ci driver, which
// runs it through `ci plan` and `ci run` as GitHub Actions does. Both set the
// machine up the same way, act on the fake GitHub the same way, and read the
// world the same way, so the only difference between them is how the machine
// works: `openOn` takes that, and makes the rest of the domain layer.
//
// A scenario's personas and reviewer pool are machine and repo config, so the
// sandbox is opened only when the scenario first acts or looks. Each persona
// runs the cast's flows (cast.ts) and no others, with Claude writing and
// Codex reviewing, as test/acceptance/review.test.ts sets them up.
//
// What it sees is the fake GitHub's records, the pushes the bare repo took
// (by the persona whose token pushed), and the fake agents' calls (by the
// persona whose token they ran with, and the branch or commit they worked
// on), read into the domain's terms by the rules in cast.ts. Each is in the
// sandbox's one order of events, its event log, which the fake GitHub, the
// bare repo and the fake agents each append to as things happen: an event's
// sequence is its line there (test/acceptance/sandbox.ts).

import type { Json } from "@chernabog/sdk";
import type { BunServices } from "@effect/platform-bun";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import type * as Scope from "effect/Scope";

import type { FakePull } from "../../acceptance/fake-github.ts";
import { type AgentSession, openSandbox, type Sandbox } from "../../acceptance/sandbox.ts";
import {
  type Domain,
  DomainFailed,
  type Login,
  type PullRequestSeen,
  type PushSeen,
  type Sequenced,
  type World,
} from "../domain.ts";
import {
  A_MAINTAINER,
  A_PERSON,
  answersAReview,
  branchOf,
  flowsOf,
  handsOff,
  issueOfBranch,
  NEEDS_HUMAN,
  reasonsOf,
  RECIPES,
  verdictOf,
} from "./cast.ts";

const NO_COMMIT = /^0+$/;

const OFF = { enabled: false };

export const failed = (message: string) => new DomainFailed({ message });

// The machine as a scenario sets it up: who is on it, who reviews, and whose
// agents dispute.
export type Cast = {
  readonly personas: ReadonlyArray<Login>;
  readonly pool: ReadonlyArray<Login>;
};

// Each recipe's settings for `login` in machine config: `on` for the cast's
// flows, and off for the rest.
const flowsFor = (login: Login, pool: ReadonlyArray<Login>, on: Json) =>
  Object.fromEntries(
    RECIPES.map((name) => [
      name,
      Option.match(
        Option.liftPredicate(name, (found) => flowsOf(login, pool).includes(found)),
        {
          onNone: (): Json => OFF,
          onSome: () => on,
        },
      ),
    ]),
  );

// The sandbox for the cast, reviews by Codex as review.test.ts has them: each
// persona's flows in machine config are `on`, and `repoConfig` goes into the
// team's config over that. The team's config lists the cast's personas, as a
// repo chernabog runs as several says who they are.
const sandboxOf = (cast: Cast, on: Json, repoConfig: Readonly<Record<string, Json>>) =>
  openSandbox(
    {
      personas: [...cast.personas],
      reviewers: [...cast.pool],
      flows: { review: { agent: "codex" }, "re-review": { agent: "codex" } },
      ...repoConfig,
    },
    {
      github: [...cast.personas],
      personas: [...cast.personas],
      personaFlows: Object.fromEntries(
        cast.personas.map((login) => [login, flowsFor(login, cast.pool, on)]),
      ),
    },
  );

type GitHub = Sandbox["github"];

const pullsOf = (github: GitHub) =>
  Arr.sort(
    [...github.pulls.values()],
    Order.mapInput(Order.Number, (pull: FakePull) => pull.number),
  );

// A pull request's head commit now, or the one it merged at once its branch is gone.
const headOf = (github: GitHub, pull: FakePull) =>
  Option.getOrElse(
    Option.orElse(github.refSha(`refs/heads/${pull.head}`), () =>
      Option.fromUndefinedOr(pull.mergedHead),
    ),
    () => "",
  );

const pullRequestSeen = (github: GitHub, pull: FakePull): PullRequestSeen => ({
  number: pull.number,
  author: pull.author,
  issue: issueOfBranch(pull.head),
  head: headOf(github, pull),
  requested: [...pull.reviewers],
  mergedBy: Option.map(
    Arr.findLast(github.merges, (merge) => merge.number === pull.number),
    (merge) => merge.by,
  ),
});

// The pull request whose head is `branch`, which work on it before it opened belongs to.
const pullOn = (pulls: ReadonlyArray<FakePull>, branch: string) =>
  Arr.findLast(pulls, (pull) => pull.head === branch);

const bySequence = Order.mapInput(Order.Number, (event: Sequenced) => event.sequence);

// Where each of the fake GitHub's records is in the event log, by what it
// said it recorded (fake-github.ts' Recorded).
type Sequences = ReadonlyMap<string, number>;

type Logged = ReturnType<Sandbox["events"]>;

// The records the event log has a place for, in its order: one it doesn't
// have yet was made as the log was read, and the next look sees it.
const sequenced = <A>(
  sequences: Sequences,
  found: ReadonlyArray<{ readonly recorded: string; readonly seen: A }>,
): ReadonlyArray<A & Sequenced> =>
  Arr.sort(
    found.flatMap(({ recorded, seen }) =>
      Option.toArray(Option.fromUndefinedOr(sequences.get(recorded))).map((sequence) => ({
        ...seen,
        sequence,
      })),
    ),
    bySequence,
  );

const reviewsSeen = (github: GitHub, pulls: ReadonlyArray<FakePull>, sequences: Sequences) =>
  sequenced(
    sequences,
    pulls.flatMap((pull) =>
      github.reviewsOf(pull.number).map((found) => ({
        recorded: `review ${found.id}`,
        seen: {
          pullRequest: pull.number,
          reviewer: found.author,
          verdict: verdictOf(found.state),
          head: found.commit_id,
          lineComments: found.comments.length,
        },
      })),
    ),
  );

const repliesSeen = (github: GitHub, pulls: ReadonlyArray<FakePull>, sequences: Sequences) =>
  sequenced(
    sequences,
    pulls.flatMap((pull) =>
      github
        .commentsOn(pull.number)
        .filter((comment) => answersAReview(comment.body))
        .map((comment) => ({
          recorded: `comment ${comment.id}`,
          seen: {
            pullRequest: pull.number,
            author: comment.user.login,
            reasons: reasonsOf(comment.body),
          },
        })),
    ),
  );

// Each push to a pull request's branch, before it opened too.
const pushesSeen = (logged: Logged, pulls: ReadonlyArray<FakePull>) =>
  logged.pushes
    .filter((push) => push.ref.startsWith("refs/heads/") && !NO_COMMIT.test(push.after))
    .flatMap((push) =>
      Option.toArray(pullOn(pulls, push.ref.slice("refs/heads/".length))).map((pull) => ({
        pullRequest: pull.number,
        by: Option.getOrElse(push.by, () => A_PERSON),
        head: push.after,
        sequence: push.sequence,
      })),
    );

// The pull request an agent call worked on: the one on its branch, or, on no
// branch (as a review's worktree is), the one whose branch was at its commit.
const pullOfCall = (
  github: GitHub,
  pulls: ReadonlyArray<FakePull>,
  pushes: ReadonlyArray<PushSeen>,
  call: AgentSession,
) =>
  Option.orElse(pullOn(pulls, call.branch), () =>
    Arr.findLast(
      pulls,
      (pull) =>
        headOf(github, pull) === call.head ||
        pushes.some((push) => push.pullRequest === pull.number && push.head === call.head),
    ),
  );

// Each agent call made as a persona on a pull request, before it opened too.
const sessionsSeen = (
  sandbox: Sandbox,
  logged: Logged,
  pulls: ReadonlyArray<FakePull>,
  pushes: ReadonlyArray<PushSeen>,
) =>
  logged.agentSessions.flatMap((call) =>
    Option.toArray(
      Option.all({
        persona: call.persona,
        pull: pullOfCall(sandbox.github, pulls, pushes, call),
      }).pipe(
        Option.map(({ persona, pull }) => ({
          pullRequest: pull.number,
          persona,
          session: call.session,
          resumed: call.call === "resume",
          sequence: call.sequence,
        })),
      ),
    ),
  );

// What can be seen in the sandbox now, in the domain's terms.
export const worldOf = (sandbox: Sandbox): World => {
  const { github } = sandbox;
  // The log first, and once: what it has is a prefix of the order, and a
  // record made after it is left for the next look rather than seen out of
  // its order.
  const logged = sandbox.events();
  const sequences = logged.records;
  const pulls = pullsOf(github);
  const numbers = new Set(pulls.map((pull) => pull.number));
  const pushes = pushesSeen(logged, pulls);

  return {
    issues: Arr.sort(
      [...github.issues.values()],
      Order.mapInput(Order.Number, (issue: { readonly number: number }) => issue.number),
    ).map((issue) => ({ number: issue.number, labels: [...issue.labels] })),
    pullRequests: pulls.map((pull) => pullRequestSeen(github, pull)),
    reviews: reviewsSeen(github, pulls, sequences),
    replies: repliesSeen(github, pulls, sequences),
    pushes,
    reviewRequests: sequenced(
      sequences,
      github.reviewRequests.flatMap((asked, index) =>
        asked.reviewers.map((reviewer) => ({
          recorded: `review-request ${index}`,
          seen: { pullRequest: asked.number, reviewer, by: asked.by },
        })),
      ),
    ),
    handOffs: sequenced(
      sequences,
      github.labelled.flatMap((found, index) =>
        Option.toArray(
          Option.liftPredicate(
            { recorded: `label ${index}`, seen: { pullRequest: found.number } },
            () => numbers.has(found.number) && handsOff(found.label),
          ),
        ),
      ),
    ),
    handBacks: sequenced(
      sequences,
      github.unlabelled.flatMap((found, index) =>
        Option.toArray(
          Option.liftPredicate(
            { recorded: `unlabel ${index}`, seen: { pullRequest: found.number, by: found.by } },
            () => numbers.has(found.number) && handsOff(found.label),
          ),
        ),
      ),
    ),
    sessions: sessionsSeen(sandbox, logged, pulls, pushes),
    merges: sequenced(
      sequences,
      github.merges.map((found, index) => ({
        recorded: `merge ${index}`,
        seen: { pullRequest: found.number, by: found.by },
      })),
    ),
  };
};

// How a driver over the sandbox makes the machine work. `R` is what it keeps
// once the sandbox is open: the sandbox, and whatever runs on it.
export type Working<R extends { readonly sandbox: Sandbox }> = {
  // Each cast flow's settings in a persona's machine config.
  readonly on: Json;
  // What goes into the team's config besides the cast's.
  readonly repoConfig: Readonly<Record<string, Json>>;
  // What it keeps of the sandbox the cast was opened in, before it starts.
  readonly make: (sandbox: Sandbox) => R;
  // Sets the machine to work.
  readonly start: (running: R) => Effect.Effect<void, DomainFailed>;
  // Stops what start started, only that, even part way; the fake GitHub
  // stops after it.
  readonly stop: (running: R) => Effect.Effect<void>;
  readonly waitUntil: <A>(
    running: R,
    description: string,
    find: (world: World) => Option.Option<A>,
  ) => Effect.Effect<A, DomainFailed>;
  readonly settle: (running: R) => Effect.Effect<void, DomainFailed>;
};

// What a scenario set up, and the machine once it starts to act.
type Machine<R> = {
  personas: ReadonlyArray<Login>;
  pool: ReadonlyArray<Login>;
  disputing: Set<Login>;
  changingWhenFixing: Set<Login>;
  running: Option.Option<R>;
  // How many pull requests people opened, to name each one's branch.
  opened: number;
};

// The sandbox and what works on it, started the first time a scenario acts
// or looks: it is the machine's, never another, however often it is asked for.
const runningOf = <R extends { readonly sandbox: Sandbox }>(
  machine: Machine<R>,
  working: Working<R>,
) =>
  Effect.suspend(() =>
    Option.match(machine.running, {
      onSome: Effect.succeed,
      onNone: () =>
        Effect.gen(function* () {
          const sandbox = yield* Effect.try({
            try: () => sandboxOf(machine, working.on, working.repoConfig),
            catch: (error) => failed(`the sandbox didn't open: ${String(error)}`),
          });

          for (const login of machine.disputing) {
            sandbox.disagreeAs(login);
          }

          for (const login of machine.changingWhenFixing) {
            sandbox.changeSpecFixingAs(login);
          }

          const running = working.make(sandbox);
          machine.running = Option.some(running);
          yield* working.start(running);

          return running;
        }),
    }),
  );

// Setting up the machine comes before anything happens on it.
const beforeActing = <R>(machine: Machine<R>, what: string, change: () => void) =>
  Option.match(machine.running, {
    onNone: () => Effect.sync(change),
    onSome: () => Effect.fail(failed(`${what} must be set up before anything happens`)),
  });

const added = (known: ReadonlyArray<Login>, logins: ReadonlyArray<Login>) => [
  ...known,
  ...logins.filter((login) => !known.includes(login)),
];

// The domain layer over the sandbox, with the machine working as `working`
// says. Closing the scenario's scope stops what it started, then the fake GitHub.
export const openOn = <R extends { readonly sandbox: Sandbox }>(
  working: Working<R>,
): Effect.Effect<Domain, never, Scope.Scope | BunServices.BunServices> =>
  Effect.gen(function* () {
    const machine: Machine<R> = {
      personas: [],
      pool: [],
      disputing: new Set(),
      changingWhenFixing: new Set(),
      running: Option.none(),
      opened: 0,
    };

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        Option.toArray(machine.running),
        (found) =>
          working
            .stop(found)
            .pipe(Effect.andThen(Effect.promise(() => found.sandbox.github.stop()))),
        { discard: true },
      ),
    );

    const running = runningOf(machine, working);

    return {
      personas: (logins) =>
        beforeActing(machine, "personas", () => {
          machine.personas = added(machine.personas, logins);
        }),
      reviewForTheTeam: (logins) =>
        beforeActing(machine, "the reviewer pool", () => {
          machine.pool = added(machine.pool, logins);
        }),
      willDispute: (author) =>
        Effect.sync(() => {
          machine.disputing.add(author);

          for (const { sandbox } of Option.toArray(machine.running)) {
            sandbox.disagreeAs(author);
          }
        }),
      willChangeSpecWhenFixing: (author) =>
        Effect.sync(() => {
          machine.changingWhenFixing.add(author);

          for (const { sandbox } of Option.toArray(machine.running)) {
            sandbox.changeSpecFixingAs(author);
          }
        }),
      // The fix changes a spec when the agent's change on the issue's branch does.
      fileIssue: (labels, fix) =>
        Effect.map(running, ({ sandbox }) => {
          const number = sandbox.github.addIssue("Filed work", labels);

          if (fix === "a spec") {
            sandbox.changeSpecOn(branchOf(number));
          }

          return number;
        }),
      openPullRequest: (author) =>
        Effect.flatMap(running, ({ sandbox }) =>
          Effect.tryPromise({
            try: () => {
              machine.opened += 1;

              return sandbox.openPullAs(author, `person-${machine.opened}`);
            },
            catch: (error) => failed(`${author} couldn't open a pull request: ${String(error)}`),
          }),
        ),
      askToReview: (pullRequest, reviewers) =>
        Effect.flatMap(running, ({ sandbox }) =>
          Effect.try({
            try: () => {
              sandbox.github.requestReview(pullRequest, reviewers, A_PERSON);
            },
            catch: () => failed(`there is no pull request #${pullRequest} to ask about`),
          }),
        ),
      changeSpec: (pullRequest, by) =>
        Effect.flatMap(running, ({ sandbox }) =>
          Effect.try({
            try: () => {
              sandbox.pushSpecChangeAs(by, sandbox.github.pull(pullRequest).head);
            },
            catch: (error) => failed(`${by} couldn't change a spec: ${String(error)}`),
          }),
        ),
      approve: (pullRequest, by) =>
        Effect.flatMap(running, ({ sandbox }) =>
          Effect.try({
            try: () => {
              sandbox.github.submitReview(pullRequest, by, "APPROVED", "Approved by hand.");
            },
            catch: () => failed(`there is no pull request #${pullRequest} to approve`),
          }),
        ),
      handBack: (pullRequest) =>
        Effect.flatMap(running, ({ sandbox }) =>
          Effect.tryPromise({
            try: () => sandbox.unlabelAs(A_MAINTAINER, pullRequest, NEEDS_HUMAN),
            catch: (error) => failed(`#${pullRequest} couldn't be handed back: ${String(error)}`),
          }),
        ),
      world: Effect.map(running, ({ sandbox }) => worldOf(sandbox)),
      waitUntil: (description, find) =>
        Effect.flatMap(running, (found) => working.waitUntil(found, description, find)),
      settle: Effect.flatMap(running, working.settle),
    } satisfies Domain;
  });
