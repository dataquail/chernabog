// Announces each phase advance to the repo's workflows (#458). A thread starts
// from the empty tree, so writing a phase starts no workflow by itself
// (docs/run-progress/storage-test.md, question 7). After each advance that
// succeeds, this sends a `repository_dispatch` of `chernabog-phase`, which
// starts the default branch's workflow (docs/ci/runner-test.md, question 3).
// It wraps the binary's adapter, so core's port knows no workflow (ADR 0005).
//
// An event is only a signal to plan again (#455): a duplicate costs one plan
// job, and a lost one leaves the item for the sweep. So a retried advance
// that finds its own write announces it again, a lost race announces nothing,
// and a failed announcement fails nothing: the phase is recorded, and the run
// log says the announcement didn't go.

import { type PhaseTransition, Progress, RunLog } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { GitHubApi, githubSend } from "../../../../platform/github-api.ts";

// The event every advance sends, which a repo's workflow listens for.
export const PHASE_EVENT = "chernabog-phase";

// What a dispatch carries: the item and its move, `from` null for its first
// phase. Three top-level keys, well inside GitHub's ten.
export const phasePayload = (item: string, transition: PhaseTransition) => ({
  item,
  from: Option.getOrNull(transition.from),
  to: transition.to,
});

const note = (line: string) =>
  Effect.serviceOption(RunLog).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (log) => log.log(line) })),
  );

// The adapter, announcing every advance it makes in `slug`, as the persona
// whose GitHubApi this is.
export const announcing = (progress: Progress["Service"], slug: string) =>
  Effect.gen(function* () {
    const api = yield* GitHubApi;

    const announce = (item: string, transition: PhaseTransition) =>
      githubSend(
        "POST",
        `/repos/${slug}/dispatches`,
        Option.some({ event_type: PHASE_EVENT, client_payload: phasePayload(item, transition) }),
      ).pipe(
        Effect.provideService(GitHubApi, api),
        Effect.asVoid,
        Effect.catch((error) =>
          note(
            `announcing ${item} as ${transition.to} failed, so the sweep picks it up: ${error.message}`,
          ),
        ),
      );

    return Progress.of({
      ...progress,
      advance: (item, transition) =>
        progress.advance(item, transition).pipe(Effect.tap(() => announce(item, transition))),
    });
  });
