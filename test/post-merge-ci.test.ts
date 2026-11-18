// Which merges post-merge has watched (audit S5, ADR 0021 decision 3): the
// merged pull request's watched record says so, not the marker in the comment
// a run leaves, so deleting that comment doesn't get the merge watched again.
// A merge watched before runs recorded it has only the marker, which still
// counts until backfill writes its record. The recipe and its document read
// and write alike.

import { describe, expect } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import postMerge from "../packages/recipes/flows/post-merge.ts";
import { flowHandle } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { documentOf, loadFlow, POST_MERGE_DOCUMENT } from "./compose-harness.ts";
import { effect } from "./effect-test.ts";
import { type Fake, flowTriggered, item, makeFake, PULL, repo, runToEnd } from "./sdk-fakes.ts";

const MERGE = "merge5678";
const PR_ITEM = `pr-${PULL}`;
const KEY = `merged-${PULL}`;

const work = item(KEY, {
  pullRequest: PULL,
  url: `https://github.com/dataquail/demo/pull/${PULL}`,
  title: "feat: a change",
  mergeSha: MERGE,
  baseRef: "main",
});

// The persona's pull request, merged a moment ago, in a CI job.
const mergedPull = () => {
  const fake = makeFake("approve", { ciJob: true });
  fake.states.pull = "merged";

  return fake;
};

const forms = [
  ["the recipe", Effect.succeed(postMerge)],
  ["the document", loadFlow(documentOf(POST_MERGE_DOCUMENT))],
] as const;

for (const [form, loading] of forms) {
  const offered = (fake: Fake) =>
    Effect.gen(function* () {
      const items = yield* flowTriggered(fake, yield* loading);

      return items.map((found) => found.key);
    }).pipe(Effect.orDie);

  describe(`post-merge's ${form}, on a merge`, () => {
    effect("recorded watched, isn't watched again, though no marker says so", () =>
      Effect.gen(function* () {
        const fake = mergedPull();
        fake.recordPhase(PR_ITEM, "watched", {
          at: yield* DateTime.now,
          data: { sha: MERGE },
        });

        expect(fake.comments).toEqual([]);
        expect(yield* offered(fake)).toEqual([]);
      }),
    );

    effect("with only the marker from before records, isn't watched again", () =>
      Effect.gen(function* () {
        const fake = mergedPull();
        fake.recordPhase(PR_ITEM, "approved", { at: yield* DateTime.now });
        fake.comment(`<!-- chernabog-post-merge-watched {"sha":"${MERGE}"} -->`);

        expect(yield* offered(fake)).toEqual([]);
      }),
    );

    effect("that nobody watched, is offered, even past its review's record", () =>
      Effect.gen(function* () {
        const fake = mergedPull();
        expect(yield* offered(fake)).toEqual([KEY]);

        fake.recordPhase(PR_ITEM, "approved", { at: yield* DateTime.now });
        expect(yield* offered(fake)).toEqual([KEY]);
      }),
    );

    effect(
      "a run records it watched with its merge commit, and it stays watched once the comment goes",
      () =>
        Effect.gen(function* () {
          const fake = mergedPull();
          fake.recordPhase(PR_ITEM, "approved", { at: yield* DateTime.now });

          const finished = yield* runToEnd(
            flowHandle(repo, "post-merge", yield* loading),
            fake,
            work,
          );

          expect(finished.status).toBe("done");

          const recorded = Option.fromUndefinedOr(fake.records().get(PR_ITEM));
          expect(Option.map(recorded, (found) => `${found.phase}`)).toEqual(Option.some("watched"));
          expect(
            Option.map(
              Option.flatMap(recorded, (found) => found.data),
              (data) => data.sha,
            ),
          ).toEqual(Option.some(MERGE));

          fake.comments.splice(0);
          expect(yield* offered(fake)).toEqual([]);
        }),
    );
  });
}
