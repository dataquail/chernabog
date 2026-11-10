// Announces each phase advance to the repo's workflows (#458). A thread starts
// from the empty tree, so writing a phase starts no workflow by itself
// (docs/run-progress/storage-test.md, question 7). After each advance that
// succeeds, this sends a `repository_dispatch` of `chernabog-phase`, which
// starts the default branch's workflow (docs/ci/runner-test.md, question 3).
// It wraps the binary's adapter, so core's port knows no workflow (ADR 0005).

import { Progress } from "@chernabog/core";
import * as Effect from "effect/Effect";

import { GitHubApi } from "../../../../platform/github-api.ts";

// The event every advance sends, which a repo's workflow listens for.
export const PHASE_EVENT = "chernabog-phase";

// The adapter, announcing every advance it makes in `slug`.
export const announcing = (progress: Progress["Service"], _slug: string) =>
  Effect.gen(function* () {
    yield* GitHubApi;

    return Progress.of(progress);
  });
