// The in-process driver (ADR 22, decision 7): the domain layer over the SDK
// fakes in test/sdk-fakes.ts and the engine, with the recipes' flows, and no
// CLI or daemon. It is the cheapest way to run a scenario.
//
// The fake acts as one login at a time (`fake.people.me`), so the driver
// plays the personas in turn, as a daemon running each of them would: it
// looks, persona by persona and flow by flow, for the first item a flow would
// start as that persona now (leaving out one held, or waiting on a login no
// persona here acts as), runs it to its end or park, and looks again. A step
// that waits does so until what it waits for can be seen, or nothing is left
// to start, or the driver has run RUNS_PER_WAIT runs, and then fails saying
// what it waited for and what ran.
//
// The fake holds one issue and the one pull request opened for it, or one a
// person opened, so a scenario may file one issue or open one pull request.
// A reviewer's first review asks for changes on one line and later ones
// approve, as the sandbox's fake agents do.
//
// The fake's commits hold no files but what the driver says: a spec, once
// one changes (cast.ts' SPEC), at a version that each change of it moves on.
// After each run, the head it pushed holds the spec as the head before it
// did, or moved on when the run was a writing one that changes it (the
// issue's fix, or a fix of a persona that changes it when fixing).

import type { Flow, WorkItem } from "@chernabog/sdk";
import type { BunServices } from "@effect/platform-bun";
import * as Arr from "effect/Array";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";

import addressReview from "../../../packages/recipes/flows/address-review.ts";
import implement from "../../../packages/recipes/flows/implement.ts";
import reReview from "../../../packages/recipes/flows/re-review.ts";
import review from "../../../packages/recipes/flows/review.ts";
import { flowHandle } from "../../../src/modules/runs/infrastructure/runtime/engine.ts";
import {
  type EngineRun,
  type Fake,
  flowTriggered,
  ISSUE,
  PULL,
  repoAs,
  repoFake,
  runUntil,
  settings,
  summaryOf,
} from "../../sdk-fakes.ts";
import {
  type Domain,
  DomainFailed,
  type Fix,
  type HandBackSeen,
  type Login,
  type PullRequestSeen,
  type World,
} from "../domain.ts";
import type { Driver } from "../runner.ts";
import {
  A_MAINTAINER,
  A_PERSON,
  answersAReview,
  changesTheSpec,
  flowsOf,
  handsOff,
  issueOfBranch,
  NEEDS_HUMAN,
  reasonsOf,
  SPEC,
  verdictOf,
} from "./cast.ts";

// The recipes' flows, by name; which a persona runs is the cast's (cast.ts).
const FLOWS = new Map<string, Flow>([
  ["implement", implement],
  ["address-review", addressReview],
  ["review", review],
  ["re-review", reReview],
]);

// How many runs one wait, or settling, may take before it gives up.
const RUNS_PER_WAIT = 20;

const NOTHING_LEFT = "nothing was left to start";

// What a scenario set up, and the fake, made once it starts to act: the
// repo's personas and reviewer pool are fixed when the fake is made.
type Machine = {
  personas: ReadonlyArray<Login>;
  pool: ReadonlyArray<Login>;
  disputing: Set<Login>;
  changingWhenFixing: Set<Login>;
  fake: Option.Option<Fake>;
  filed: boolean;
  // What the filed issue's fix changes.
  fix: Fix;
  // The spec's version: none changed yet at 0.
  spec: number;
  // Each hand-back, as the world shows it.
  handBacks: Array<HandBackSeen>;
  // What each run did, for a failure to say.
  ran: Array<string>;
};

const failed = (message: string) => new DomainFailed({ message });

const recipesOf = (machine: Machine, login: Login) =>
  flowsOf(login, machine.pool).flatMap((name) =>
    Option.toArray(Option.fromUndefinedOr(FLOWS.get(name))).map((flow) => [name, flow] as const),
  );

const repoSettingsOf = (machine: Machine) => ({
  ...settings,
  personas: [...machine.personas],
  reviewers: [...machine.pool],
});

const fakeOf = (machine: Machine) =>
  Effect.sync(() =>
    Option.getOrElse(machine.fake, () => {
      const made = repoFake(["request-changes", "approve"], repoSettingsOf(machine));
      // Nothing is queued or asked for until a scenario says so.
      made.setLabels(ISSUE, []);
      made.setLabels(PULL, []);
      machine.fake = Option.some(made);

      return made;
    }),
  );

// Setting up the machine comes before anything happens on it.
const beforeActing = (machine: Machine, what: string, change: () => void) =>
  Option.match(machine.fake, {
    onNone: () => Effect.sync(change),
    onSome: () => Effect.fail(failed(`${what} must be set up before anything happens`)),
  });

const pullRequestSeen = (fake: Fake): PullRequestSeen => ({
  number: PULL,
  author: fake.authored.author,
  issue: issueOfBranch(fake.authored.headRef),
  head: fake.git.head,
  requested: [...fake.people.requested],
  mergedBy: Option.map(
    Arr.findLast(fake.acts.merges, (merge) => merge.pullRequest === PULL),
    (merge) => merge.by,
  ),
});

// What can be seen on the fake: everything happens on its one issue and one
// pull request, the pushes and agent sessions before it opened included. The
// histories are in the fake's one order of acts: each act's sequence is the
// one the fake gave it as it was done.
const worldOf = (machine: Machine, fake: Fake): World => ({
  issues: Arr.filter([{ number: ISSUE, labels: fake.labelsOf(ISSUE) }], () => machine.filed),
  pullRequests: Arr.filter([pullRequestSeen(fake)], () => fake.git.opened),
  reviews: fake.acts.reviews.map((found) => ({
    pullRequest: PULL,
    reviewer: found.author,
    verdict: verdictOf(found.state),
    head: found.commitSha,
    lineComments: found.lineComments,
    sequence: found.sequence,
  })),
  replies: fake.acts.comments
    .filter((found) => found.on === PULL && answersAReview(found.body))
    .map((found) => ({
      pullRequest: PULL,
      author: found.author,
      reasons: reasonsOf(found.body),
      sequence: found.sequence,
    })),
  pushes: fake.acts.pushes.map((found) => ({ pullRequest: PULL, ...found })),
  reviewRequests: fake.acts.reviewRequests.flatMap((found) =>
    found.reviewers.map((reviewer) => ({
      pullRequest: PULL,
      reviewer,
      by: found.by,
      sequence: found.sequence,
    })),
  ),
  handOffs: fake.acts.labelled
    .filter((found) => found.number === PULL && handsOff(found.label))
    .map((found) => ({ pullRequest: PULL, sequence: found.sequence })),
  // The fake agent can't say whether it resumed: a session it ran before
  // under the same id is one the agent's adapter would resume.
  handBacks: [...machine.handBacks],
  sessions: fake.acts.sessions.map((found, index) => ({
    pullRequest: PULL,
    persona: found.persona,
    session: found.sessionId,
    resumed: fake.acts.sessions
      .slice(0, index)
      .some((earlier) => earlier.sessionId === found.sessionId),
    sequence: found.sequence,
  })),
  merges: fake.acts.merges.map((found) => ({ ...found })),
});

// What a run needs of the scenario: its scope, which keeps each run's engine
// until the scenario ends, and Bun's platform services.
type Platform = Context.Context<Scope.Scope | BunServices.BunServices>;

type Turn = {
  readonly login: Login;
  readonly name: string;
  readonly flow: Flow;
  readonly work: WorkItem;
};

const startable = (work: WorkItem) =>
  Option.isNone(Option.fromUndefinedOr(work.held)) &&
  Option.isNone(Option.fromUndefinedOr(work.waitsOn));

// The work `flow` would start now as `login`, as a tick would find it.
const workFor = (fake: Fake, context: Platform, login: Login, name: string, flow: Flow) =>
  Effect.suspend(() => {
    fake.people.me = login;

    return flowTriggered(fake, flow);
  }).pipe(
    Effect.provideContext(context),
    Effect.map((items) =>
      Arr.findFirst(items, startable).pipe(
        Option.map((work): Turn => ({ login, name, flow, work })),
      ),
    ),
    Effect.mapError((error) => failed(`${name}'s trigger as ${login} failed: ${String(error)}`)),
  );

// The first work any persona's flow would start now, persona by persona.
const nextTurn = (machine: Machine, fake: Fake, context: Platform) =>
  Effect.gen(function* () {
    for (const login of machine.personas) {
      for (const [name, flow] of recipesOf(machine, login)) {
        const found = yield* workFor(fake, context, login, name, flow);

        if (Option.isSome(found)) {
          return found;
        }
      }
    }

    return Option.none<Turn>();
  });

// A commit's tree, as far as the spec guard reads it: the spec at `version`.
const holdsSpec = (fake: Fake, sha: string, version: number) => {
  fake.trees.set(sha, [{ path: SPEC, sha: `spec-${version}` }]);
  fake.merge.files = [...fake.merge.files.filter((path) => path !== SPEC), SPEC];
};

// The spec moves on to a new version at `sha`.
const specChanged = (machine: Machine, fake: Fake, sha: string) => {
  machine.spec += 1;
  holdsSpec(fake, sha, machine.spec);
};

// After `turn` ran: the head it left holds the spec as the head before it,
// or a new version of it if the turn's writing changed it.
const treeAfter = (machine: Machine, fake: Fake, turn: Turn) => {
  const head = fake.git.head;

  if (fake.trees.has(head)) {
    return;
  }

  if (
    changesTheSpec(turn.name, {
      fix: machine.fix,
      changingWhenFixing: machine.changingWhenFixing.has(turn.login),
    })
  ) {
    specChanged(machine, fake, head);
  } else if (machine.spec > 0) {
    holdsSpec(fake, head, machine.spec);
  }
};

const ended = (run: EngineRun) => run.status !== "running" || ("parked" in run && run.parked);

// Runs one turn's work as its persona, to its end or park. A run that fails,
// or never gets there, is a failure of the scenario's, not an outcome.
const play = (machine: Machine, fake: Fake, context: Platform, turn: Turn) =>
  Effect.gen(function* () {
    fake.people.me = turn.login;
    fake.author.consider = Option.match(
      Option.liftPredicate(turn.login, (login) => machine.disputing.has(login)),
      { onNone: () => "address", onSome: () => "decline" },
    );

    const handle = flowHandle(repoAs(repoSettingsOf(machine)), turn.name, turn.flow);

    const what = `${turn.name} as ${turn.login} on ${turn.work.key}`;

    const run = yield* runUntil(handle, fake, turn.work, (now) => Effect.succeed(ended(now))).pipe(
      Effect.provideContext(context),
      Effect.mapError((error) => failed(`${what} couldn't start: ${String(error)}`)),
    );

    machine.ran.push(`${what}: ${run.status} (${summaryOf(run)})`);
    treeAfter(machine, fake, turn);

    if (run.status === "failed" || !ended(run)) {
      return yield* failed(`${what} ${run.status}: ${summaryOf(run)}`);
    }
  });

const history = (machine: Machine) =>
  Option.match(Arr.match(machine.ran, { onEmpty: Option.none, onNonEmpty: Option.some }), {
    onNone: () => "nothing ran",
    onSome: (ran) => `ran:\n${ran.map((line) => `  ${line}`).join("\n")}`,
  });

// Plays turns until `done` says the world is as wanted, or there is nothing
// left to start, or RUNS_PER_WAIT runs have gone by.
const playUntil = <A>(
  machine: Machine,
  context: Platform,
  done: (world: World) => Option.Option<A>,
): Effect.Effect<Result.Result<A, string>, DomainFailed> =>
  Effect.gen(function* () {
    const fake = yield* fakeOf(machine);

    for (let runs = 0; runs < RUNS_PER_WAIT; runs += 1) {
      const found = done(worldOf(machine, fake));

      if (Option.isSome(found)) {
        return Result.succeed(found.value);
      }

      const turn = yield* nextTurn(machine, fake, context);

      if (Option.isNone(turn)) {
        return Result.fail(NOTHING_LEFT);
      }

      yield* play(machine, fake, context, turn.value);
    }

    return Option.match(done(worldOf(machine, fake)), {
      onSome: (found) => Result.succeed(found),
      onNone: () => Result.fail(`there was still work after ${RUNS_PER_WAIT} runs`),
    });
  });

// The fake's pull request, once it is open.
const openPull = (machine: Machine, pullRequest: number) =>
  fakeOf(machine).pipe(
    Effect.filterOrFail(
      (fake) => pullRequest === PULL && fake.git.opened,
      () => failed(`there is no pull request #${pullRequest}`),
    ),
  );

const domainOver = (machine: Machine, context: Platform): Domain => ({
  personas: (logins) =>
    beforeActing(machine, "personas", () => {
      machine.personas = [
        ...machine.personas,
        ...logins.filter((login) => !machine.personas.includes(login)),
      ];
    }),
  reviewForTheTeam: (logins) =>
    beforeActing(machine, "the reviewer pool", () => {
      machine.pool = [...machine.pool, ...logins.filter((login) => !machine.pool.includes(login))];
    }),
  willDispute: (author) =>
    Effect.sync(() => {
      machine.disputing.add(author);
    }),
  willChangeSpecWhenFixing: (author) =>
    Effect.sync(() => {
      machine.changingWhenFixing.add(author);
    }),
  fileIssue: (labels, fix) =>
    Effect.gen(function* () {
      const fake = yield* fakeOf(machine);

      if (machine.filed || fake.git.opened) {
        return yield* failed(
          "the in-process driver holds one issue or pull request, and this files another",
        );
      }

      machine.filed = true;
      machine.fix = fix;
      fake.setLabels(ISSUE, [...labels]);

      return ISSUE;
    }),
  openPullRequest: (author) =>
    Effect.gen(function* () {
      const fake = yield* fakeOf(machine);

      if (machine.filed || fake.git.opened) {
        return yield* failed(
          "the in-process driver holds one issue or pull request, and this opens another",
        );
      }

      fake.authored.author = author;
      fake.authored.headRef = "feature";
      fake.git.opened = true;

      return PULL;
    }),
  askToReview: (pullRequest, reviewers) =>
    Effect.gen(function* () {
      const fake = yield* fakeOf(machine);

      yield* openPull(machine, pullRequest);

      fake.people.requested = [
        ...fake.people.requested.filter((login) => !reviewers.includes(login)),
        ...reviewers,
      ];
      fake.acts.reviewRequests.push({
        by: A_PERSON,
        reviewers: [...reviewers],
        sequence: fake.acts.next(),
      });
    }),
  changeSpec: (pullRequest, by) =>
    Effect.gen(function* () {
      const fake = yield* openPull(machine, pullRequest);

      fake.git.pushes += 1;
      fake.git.head = `person${fake.git.pushes}000000`;
      fake.acts.pushes.push({ by, head: fake.git.head, sequence: fake.acts.next() });
      specChanged(machine, fake, fake.git.head);
    }),
  // As on GitHub, a review drops its author from the requested reviewers. A
  // persona's login is trusted as a person's is: the guard tells them apart.
  approve: (pullRequest, by) =>
    Effect.gen(function* () {
      const fake = yield* openPull(machine, pullRequest);
      const commitSha = fake.git.head;

      fake.submitted.push({ author: by, state: "APPROVED", commitSha, trusted: true });
      fake.acts.reviews.push({
        author: by,
        state: "APPROVED",
        commitSha,
        lineComments: 0,
        sequence: fake.acts.next(),
      });
      fake.people.requested = fake.people.requested.filter((login) => login !== by);
    }),
  // A maintainer takes the label off, which GitHub lists as theirs, now.
  handBack: (pullRequest) =>
    Effect.gen(function* () {
      const fake = yield* openPull(machine, pullRequest);

      if (!fake.labelsOf(PULL).includes(NEEDS_HUMAN)) {
        return yield* failed(`#${pullRequest} isn't handed to a person`);
      }

      fake.setLabels(
        PULL,
        fake.labelsOf(PULL).filter((label) => label !== NEEDS_HUMAN),
      );
      fake.timeline.permissions.set(A_MAINTAINER, "write");
      fake.timeline.events.set(PULL, [
        ...Option.getOrElse(Option.fromUndefinedOr(fake.timeline.events.get(PULL)), () => []),
        {
          event: "unlabeled",
          label: { name: NEEDS_HUMAN },
          actor: { login: A_MAINTAINER },
          created_at: DateTime.formatIso(yield* DateTime.now),
        },
      ]);
      machine.handBacks.push({ pullRequest, by: A_MAINTAINER, sequence: fake.acts.next() });
    }),
  world: Effect.map(fakeOf(machine), (fake) => worldOf(machine, fake)),
  waitUntil: (description, find) =>
    playUntil(machine, context, find).pipe(
      Effect.flatMap(
        Result.match({
          onSuccess: Effect.succeed,
          onFailure: (why) =>
            Effect.fail(failed(`waited for ${description}, but ${why}; ${history(machine)}`)),
        }),
      ),
    ),
  settle: playUntil(machine, context, Option.none<never>).pipe(
    Effect.flatMap(
      Result.match({
        onSuccess: () => Effect.void,
        onFailure: (why) => {
          if (why === NOTHING_LEFT) {
            return Effect.void;
          }

          return Effect.fail(failed(`it never settled: ${why}; ${history(machine)}`));
        },
      }),
    ),
  ),
});

export const inProcess: Driver = {
  name: "in-process",
  open: Effect.gen(function* () {
    const context = yield* Effect.context<Scope.Scope | BunServices.BunServices>();

    const machine: Machine = {
      personas: [],
      pool: [],
      disputing: new Set(),
      changingWhenFixing: new Set(),
      fake: Option.none(),
      filed: false,
      fix: "code",
      spec: 0,
      handBacks: [],
      ran: [],
    };

    return domainOver(machine, context);
  }),
  timeout: 60_000,
};
