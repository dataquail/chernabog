import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import { type Persona } from "../../../../../kernel/persona.value-object.ts";
import {
  type IssueSeed,
  type PullRequestSeed,
} from "../../../../../kernel/scenario.value-object.ts";
import { type ScratchRepoFailed } from "../../scenario/scenario.errors.ts";

// An issue or pull request as a rehearsal checks it afterwards.
export type ItemState = {
  readonly labels: ReadonlyArray<string>;
  // The logins a pull request still asks to review it; none for an issue.
  readonly reviewRequests: ReadonlyArray<string>;
};

// A claim ref a rehearsal's run took, as the run's journal recorded it: the
// item it claims (`issue-12`, `epic-3`) and the run its claim names.
export type RunClaim = { readonly item: string; readonly runId: string };

// How an issue went away: GitHub deletes one only for an admin, so otherwise it is closed.
export type IssueRemoval = "deleted" | "closed";

// The repo a rehearsal seeds on GitHub, and cleans up after, each call as a
// persona. One thing at a time, so a seeding that fails partway leaves a
// record of what it made, for cleanup to remove.
export type ScratchRepoClientService = {
  readonly defaultBranch: (repo: string, as: Persona) => Effect.Effect<string, ScratchRepoFailed>;
  readonly openIssue: (
    repo: string,
    seed: IssueSeed,
    as: Persona,
  ) => Effect.Effect<number, ScratchRepoFailed>;
  // Makes the branch from `base` with the seed's commits, and opens the pull request from it.
  readonly openPullRequest: (
    repo: string,
    base: string,
    seed: PullRequestSeed,
    as: Persona,
  ) => Effect.Effect<number, ScratchRepoFailed>;
  readonly stateOf: (
    repo: string,
    number: number,
    as: Persona,
  ) => Effect.Effect<ItemState, ScratchRepoFailed>;
  // The pull requests from a branch, open or closed.
  readonly pullRequestsFrom: (
    repo: string,
    branch: string,
    as: Persona,
  ) => Effect.Effect<ReadonlyArray<number>, ScratchRepoFailed>;
  readonly removeIssue: (
    repo: string,
    number: number,
    as: Persona,
  ) => Effect.Effect<IssueRemoval, ScratchRepoFailed>;
  readonly closePullRequest: (
    repo: string,
    number: number,
    as: Persona,
  ) => Effect.Effect<void, ScratchRepoFailed>;
  // Deletes the claim ref on the claim's item while it still names the
  // claim's run, and says which ref it deleted; none when another run holds
  // the item, or nobody does, which it leaves alone.
  readonly releaseClaimRef: (
    repo: string,
    claim: RunClaim,
    as: Persona,
  ) => Effect.Effect<Option.Option<string>, ScratchRepoFailed>;
  // Deleting a branch that is already gone succeeds.
  readonly deleteBranch: (
    repo: string,
    branch: string,
    as: Persona,
  ) => Effect.Effect<void, ScratchRepoFailed>;
};

export class ScratchRepoClient extends Context.Service<
  ScratchRepoClient,
  ScratchRepoClientService
>()("ScratchRepoClient") {}
