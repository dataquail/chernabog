// A driver for the runner's own tests: the domain layer over a world kept in
// memory, with no chernabog behind it. Nothing happens on its own, so it can
// show the runner runs steps in order on a fresh domain per scenario, and
// nothing about chernabog. The real drivers are in-process and sandbox.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { type Domain, DomainFailed, type Login, type World } from "../features/domain.ts";
import type { Driver } from "../features/runner.ts";

const EMPTY: World = {
  issues: [],
  pullRequests: [],
  reviews: [],
  replies: [],
  pushes: [],
  reviewRequests: [],
  handOffs: [],
  sessions: [],
};

const nextNumber = (world: World) => world.issues.length + world.pullRequests.length + 1;

const domainOver = (world: Ref.Ref<World>): Domain => ({
  personas: () => Effect.void,
  reviewForTheTeam: () => Effect.void,
  willDispute: () => Effect.void,
  fileIssue: (labels) =>
    Ref.modify(world, (now) => {
      const number = nextNumber(now);

      return [number, { ...now, issues: [...now.issues, { number, labels }] }];
    }),
  openPullRequest: (author: Login) =>
    Ref.modify(world, (now) => {
      const number = nextNumber(now);

      const opened = {
        number,
        author,
        issue: Option.none<number>(),
        head: `head-${number}`,
        requested: [],
        mergedBy: Option.none<Login>(),
      };

      return [number, { ...now, pullRequests: [...now.pullRequests, opened] }];
    }),
  askToReview: (pullRequest, reviewers) =>
    Ref.update(world, (now) => ({
      ...now,
      pullRequests: now.pullRequests.map((pull) => {
        if (pull.number !== pullRequest) {
          return pull;
        }

        return { ...pull, requested: [...pull.requested, ...reviewers] };
      }),
      reviewRequests: [
        ...now.reviewRequests,
        ...reviewers.map((reviewer) => ({ pullRequest, reviewer, by: "a person" })),
      ],
    })),
  world: Ref.get(world),
  waitUntil: (description, find) =>
    Ref.get(world).pipe(
      Effect.flatMap((now) => Effect.fromOption(find(now))),
      Effect.mapError(
        () => new DomainFailed({ message: `waited for ${description}, and it never came` }),
      ),
    ),
  settle: Effect.void,
});

export const memory: Driver = {
  name: "memory",
  open: Ref.make(EMPTY).pipe(Effect.map(domainOver)),
  timeout: 5_000,
};
