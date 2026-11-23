// The sandbox driver (ADR 22, decision 7): the domain layer over the real CLI
// and daemon in openSandbox (test/acceptance/sandbox.ts), against the fake
// GitHub (test/acceptance/fake-github.ts) and the fake gh, claude and codex in
// test/fakebin/.
//
// A scenario's personas and reviewer pool are machine and repo config, so the
// driver opens the sandbox and starts the daemon only when the scenario first
// acts or looks, as the in-process driver makes its fake. Each persona runs
// the cast's flows (cast.ts) every two seconds and no others, with Claude
// writing and Codex reviewing, as test/acceptance/review.test.ts sets them up.
// Closing the scenario's scope stops the daemon this driver started, and the
// fake GitHub.
//
// What it sees is the fake GitHub's records, the pushes the bare repo took
// (by the persona whose token pushed), and the fake agents' calls (by the
// persona whose token they ran with, and the branch or commit they worked
// on), read into the domain's terms by the rules in cast.ts. A wait
// looks again every POLL_MS for up to WAIT_MS; settling waits until the
// daemon, asked for its status, has nothing running or queued and each of
// its flows has ticked IDLE_TICKS times with no run starting or ending.

import type { Json } from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schedule from "effect/Schedule";

import type { DaemonStatus } from "../../../src/interface/daemon/daemon.protocol.ts";
import type { FakePull } from "../../acceptance/fake-github.ts";
import { type AgentSession, openSandbox, type Sandbox } from "../../acceptance/sandbox.ts";
import {
  type Domain,
  DomainFailed,
  type Login,
  type PullRequestSeen,
  type PushSeen,
  type World,
} from "../domain.ts";
import type { Driver } from "../runner.ts";
import {
  A_PERSON,
  answersAReview,
  flowsOf,
  handsOff,
  issueOfBranch,
  reasonsOf,
  RECIPES,
  verdictOf,
} from "./cast.ts";

// How often a wait looks again, and how long it waits.
const POLL_MS = 250;
const WAIT_MS = 90_000;

// How many ticks of every flow, with nothing running, make the machine settled.
const IDLE_TICKS = 2;

// A persona's flows run every two seconds; the ones it doesn't run are off.
const OFTEN = { schedule: "*/2 * * * * *" };
const OFF = { enabled: false };

const NO_COMMIT = /^0+$/;

type Running = {
  readonly sandbox: Sandbox;
  daemon: Option.Option<ReturnType<Sandbox["cli"]>>;
};

// What a scenario set up, and the sandbox once it starts to act.
type Machine = {
  personas: ReadonlyArray<Login>;
  pool: ReadonlyArray<Login>;
  disputing: Set<Login>;
  running: Option.Option<Running>;
  // How many pull requests people opened, to name each one's branch.
  opened: number;
};

const failed = (message: string) => new DomainFailed({ message });

const flowsFor = (login: Login, pool: ReadonlyArray<Login>): Readonly<Record<string, Json>> =>
  Object.fromEntries(
    RECIPES.map((name) => [
      name,
      Option.match(
        Option.liftPredicate(name, (found) => flowsOf(login, pool).includes(found)),
        {
          onNone: () => OFF,
          onSome: () => OFTEN,
        },
      ),
    ]),
  );

// The machine as the scenario set it up, reviews by Codex as review.test.ts has them.
const sandboxOf = (machine: Machine) =>
  openSandbox(
    {
      reviewers: [...machine.pool],
      flows: { review: { agent: "codex" }, "re-review": { agent: "codex" } },
    },
    {
      github: [...machine.personas],
      personas: [...machine.personas],
      personaFlows: Object.fromEntries(
        machine.personas.map((login) => [login, flowsFor(login, machine.pool)]),
      ),
    },
  );

// Trusts the repo's .chernabog/ and starts the daemon, as a person does.
const daemonUp = (running: Running) =>
  Effect.gen(function* () {
    const { sandbox } = running;

    const trusted = yield* Effect.tryPromise({
      try: () => sandbox.runCli(["trust", "demo"]),
      catch: (error) => failed(`trust didn't run: ${String(error)}`),
    });

    if (trusted.code !== 0) {
      return yield* failed(`trust failed: ${trusted.output}`);
    }

    running.daemon = Option.some(sandbox.cli(["daemon"]));

    yield* Effect.tryPromise({
      try: () => sandbox.daemonReady(),
      catch: (error) => failed(`the daemon didn't start: ${String(error)}`),
    });
  });

// The sandbox and its daemon, started the first time a scenario acts or
// looks: it is the machine's, never another, however often it is asked for.
const runningOf = (machine: Machine) =>
  Effect.suspend(() =>
    Option.match(machine.running, {
      onSome: Effect.succeed,
      onNone: () =>
        Effect.gen(function* () {
          const sandbox = yield* Effect.try({
            try: () => sandboxOf(machine),
            catch: (error) => failed(`the sandbox didn't open: ${String(error)}`),
          });

          const running: Running = { sandbox, daemon: Option.none() };
          machine.running = Option.some(running);

          for (const login of machine.disputing) {
            sandbox.disagreeAs(login);
          }

          yield* daemonUp(running);

          return running;
        }),
    }),
  );

// Stops the daemon this driver started, only it, and the fake GitHub.
const stopped = ({ daemon, sandbox }: Running) =>
  Effect.forEach(
    Option.toArray(daemon),
    (child) => Effect.promise(() => sandbox.stopDaemon(child)),
    {
      discard: true,
    },
  ).pipe(Effect.andThen(Effect.promise(() => sandbox.github.stop())));

// Setting up the machine comes before anything happens on it.
const beforeActing = (machine: Machine, what: string, change: () => void) =>
  Option.match(machine.running, {
    onNone: () => Effect.sync(change),
    onSome: () => Effect.fail(failed(`${what} must be set up before anything happens`)),
  });

const added = (known: ReadonlyArray<Login>, logins: ReadonlyArray<Login>) => [
  ...known,
  ...logins.filter((login) => !known.includes(login)),
];

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

const reviewsSeen = (github: GitHub, pulls: ReadonlyArray<FakePull>) =>
  Arr.sort(
    pulls.flatMap((pull) => github.reviewsOf(pull.number).map((found) => ({ pull, found }))),
    Order.mapInput(
      Order.Number,
      ({ found }: { readonly found: { readonly id: number } }) => found.id,
    ),
  ).map(({ found, pull }) => ({
    pullRequest: pull.number,
    reviewer: found.author,
    verdict: verdictOf(found.state),
    head: found.commit_id,
    lineComments: found.comments.length,
  }));

const repliesSeen = (github: GitHub, pulls: ReadonlyArray<FakePull>) =>
  Arr.sort(
    pulls.flatMap((pull) =>
      github
        .commentsOn(pull.number)
        .filter((comment) => answersAReview(comment.body))
        .map((comment) => ({
          id: comment.id,
          pullRequest: pull.number,
          author: comment.user.login,
          reasons: reasonsOf(comment.body),
        })),
    ),
    Order.mapInput(Order.Number, (reply: { readonly id: number }) => reply.id),
  ).map(({ author, pullRequest, reasons }) => ({ pullRequest, author, reasons }));

// Each push to a pull request's branch, before it opened too.
const pushesSeen = (sandbox: Sandbox, pulls: ReadonlyArray<FakePull>) =>
  sandbox
    .pushes()
    .filter((push) => push.ref.startsWith("refs/heads/") && !NO_COMMIT.test(push.after))
    .flatMap((push) =>
      Option.toArray(pullOn(pulls, push.ref.slice("refs/heads/".length))).map((pull) => ({
        pullRequest: pull.number,
        by: Option.getOrElse(push.by, () => A_PERSON),
        head: push.after,
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
  pulls: ReadonlyArray<FakePull>,
  pushes: ReadonlyArray<PushSeen>,
) =>
  sandbox.agentSessions().flatMap((call) =>
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
        })),
      ),
    ),
  );

const worldOf = ({ sandbox }: Running): World => {
  const { github } = sandbox;
  const pulls = pullsOf(github);
  const numbers = new Set(pulls.map((pull) => pull.number));
  const pushes = pushesSeen(sandbox, pulls);

  return {
    issues: Arr.sort(
      [...github.issues.values()],
      Order.mapInput(Order.Number, (issue: { readonly number: number }) => issue.number),
    ).map((issue) => ({ number: issue.number, labels: [...issue.labels] })),
    pullRequests: pulls.map((pull) => pullRequestSeen(github, pull)),
    reviews: reviewsSeen(github, pulls),
    replies: repliesSeen(github, pulls),
    pushes,
    reviewRequests: github.reviewRequests.flatMap((asked) =>
      asked.reviewers.map((reviewer) => ({
        pullRequest: asked.number,
        reviewer,
        by: asked.by,
      })),
    ),
    handOffs: github.labelled
      .filter((found) => numbers.has(found.number) && handsOff(found.label))
      .map((found) => ({ pullRequest: found.number })),
    sessions: sessionsSeen(sandbox, pulls, pushes),
  };
};

// The end of the daemon's log, for a failure to show what it did.
const logTail = ({ sandbox }: Running) =>
  `the daemon's log ends:\n${sandbox.daemonLog().split("\n").slice(-40).join("\n")}`;

// Looks with `find` every POLL_MS until it finds something, or fails with
// `why` once WAIT_MS have gone by.
const pollFor = <A>(
  running: Running,
  find: () => Effect.Effect<Option.Option<A>, DomainFailed>,
  why: () => string,
): Effect.Effect<A, DomainFailed> =>
  Effect.suspend(find).pipe(
    Effect.repeat({ schedule: Schedule.spaced(POLL_MS), until: Option.isSome }),
    Effect.timeoutOption(WAIT_MS),
    Effect.map(Option.flatten),
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () => Effect.fail(failed(`${why()}; ${logTail(running)}`)),
      }),
    ),
  );

const statusOf = ({ sandbox }: Running) =>
  Effect.tryPromise({
    try: () => sandbox.daemonStatus(),
    catch: (error) => failed(`the daemon's status couldn't be read: ${String(error)}`),
  });

// What would make the machine not idle now: a run in flight that isn't
// parked, or work a flow that runs here found and hasn't started. A flow
// that's off (as a persona's flows outside the cast are) only skips its ticks.
const busyWith = (status: DaemonStatus) => [
  ...status.active
    .filter((run) => !run.parked)
    .map((run) => `${run.flow} ${run.itemKey} is running`),
  ...status.repos.flatMap((repo) =>
    repo.flows
      .filter((flow) => flow.enabled)
      .flatMap((flow) => [
        ...flow.queued.map((item) => `${flow.name} has ${item} queued`),
        ...Option.toArray(Option.fromUndefinedOr(flow.pending)).map(
          (event) => `${flow.name} has a tick due for ${event}`,
        ),
      ]),
  ),
];

// Which runs there are, so a run starting or ending between looks is seen.
const runsOf = (status: DaemonStatus) =>
  [...status.active.map((run) => `${run.id}:${run.parked}`), ...status.recent.map((run) => run.id)]
    .toSorted()
    .join(",");

const enabledFlows = (status: DaemonStatus) =>
  status.repos.flatMap((repo) =>
    repo.flows
      .filter((flow) => flow.enabled)
      .map((flow) => ({
        key: `${repo.name}/${flow.name}@${Option.getOrElse(Option.fromUndefinedOr(flow.persona), () => "")}`,
        lastTick: Option.getOrElse(flow.lastTick, () => ""),
      })),
  );

type Ticks = { readonly last: string; readonly count: number };

// The idle stretch so far: the runs it began with, each flow's last tick and
// how many it has had since, and what ended the stretch before it.
type Quiet = {
  readonly runs: string;
  readonly ticks: Map<string, Ticks>;
  readonly why: string;
};

const quietFrom = (status: DaemonStatus, why: string): Quiet => ({
  runs: runsOf(status),
  ticks: new Map(enabledFlows(status).map((flow) => [flow.key, { last: flow.lastTick, count: 0 }])),
  why,
});

const ticksOf = (quiet: Quiet, key: string, lastTick: string): Ticks =>
  Option.getOrElse(Option.fromUndefinedOr(quiet.ticks.get(key)), () => ({
    last: lastTick,
    count: 0,
  }));

// Whether the idle stretch has gone on long enough, counting the ticks `status` shows.
const settledAt = (quiet: Quiet, status: DaemonStatus) => {
  const flows = enabledFlows(status);

  for (const flow of flows) {
    const seen = ticksOf(quiet, flow.key, flow.lastTick);

    if (seen.last !== flow.lastTick) {
      quiet.ticks.set(flow.key, { last: flow.lastTick, count: seen.count + 1 });
    }
  }

  return (
    flows.length > 0 &&
    flows.every((flow) => ticksOf(quiet, flow.key, flow.lastTick).count >= IDLE_TICKS)
  );
};

// Waits until the daemon has had IDLE_TICKS ticks of every flow with nothing
// running or queued, and no run starting or ending: what it would do next,
// it would have done by then.
const settle = (running: Running) =>
  Effect.gen(function* () {
    let quiet = quietFrom(yield* statusOf(running), "nothing was seen yet");

    yield* pollFor(
      running,
      () =>
        Effect.map(statusOf(running), (status) => {
          const busy = busyWith(status);

          if (busy.length > 0 || runsOf(status) !== quiet.runs) {
            quiet = quietFrom(
              status,
              Arr.match(busy, {
                onEmpty: () => "a run started or ended",
                onNonEmpty: (found) => found.join("; "),
              }),
            );

            return Option.none();
          }

          return Option.liftPredicate(true, () => settledAt(quiet, status));
        }),
      () => `it never settled: last, ${quiet.why}`,
    );
  });

const domainOver = (machine: Machine): Domain => ({
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
  fileIssue: (labels) =>
    Effect.map(runningOf(machine), ({ sandbox }) => sandbox.github.addIssue("Filed work", labels)),
  openPullRequest: (author) =>
    Effect.flatMap(runningOf(machine), ({ sandbox }) =>
      Effect.tryPromise({
        try: () => {
          machine.opened += 1;

          return sandbox.openPullAs(author, `person-${machine.opened}`);
        },
        catch: (error) => failed(`${author} couldn't open a pull request: ${String(error)}`),
      }),
    ),
  askToReview: (pullRequest, reviewers) =>
    Effect.flatMap(runningOf(machine), ({ sandbox }) =>
      Effect.try({
        try: () => {
          sandbox.github.requestReview(pullRequest, reviewers, A_PERSON);
        },
        catch: () => failed(`there is no pull request #${pullRequest} to ask about`),
      }),
    ),
  world: Effect.map(runningOf(machine), worldOf),
  waitUntil: (description, find) =>
    Effect.flatMap(runningOf(machine), (running) =>
      pollFor(
        running,
        () => Effect.sync(() => find(worldOf(running))),
        () => `waited ${WAIT_MS / 1000}s for ${description}`,
      ),
    ),
  settle: Effect.flatMap(runningOf(machine), settle),
});

export const sandbox: Driver = {
  name: "sandbox",
  open: Effect.gen(function* () {
    const machine: Machine = {
      personas: [],
      pool: [],
      disputing: new Set(),
      running: Option.none(),
      opened: 0,
    };

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Option.toArray(machine.running), stopped, { discard: true }),
    );

    return domainOver(machine);
  }),
  timeout: 240_000,
};
