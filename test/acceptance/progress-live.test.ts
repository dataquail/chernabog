// The protected-branch Progress adapter on a real GitHub repo: the contract
// every adapter passes, and real races between two personas, each with one
// winner. It writes branches, so it runs only when it's given a scratch repo:
//
//   CHERNABOG_PROGRESS_LIVE_REPO=owner/scratch \
//   CHERNABOG_PROGRESS_LIVE_PERSONAS=alice,bob bun test test/acceptance/progress-live.test.ts
//
// Both logins need a token in gh (`gh auth login`) and write access to the
// repo. Each test keeps its threads under a prefix of its own and deletes
// them when it ends, so it holds no records to start with and leaves none.

import { Phase, PhaseWriter, type Progress } from "@chernabog/core";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { makeThreadsProgress } from "../../src/modules/runs/infrastructure/runtime/progress.ts";
import { HostEnvironment } from "../../src/platform/environment.ts";
import { Exec } from "../../src/platform/exec.ts";
import { GitHubApi, githubGetAllPages, githubRequest } from "../../src/platform/github-api.ts";
import { GitHubTokens } from "../../src/platform/github-auth.ts";
import { effect } from "../effect-test.ts";
import { progressContract } from "../progress-contract.ts";

const REPO = Option.fromUndefinedOr(process.env.CHERNABOG_PROGRESS_LIVE_REPO);

const PERSONAS = Option.getOrElse(
  Option.map(Option.fromUndefinedOr(process.env.CHERNABOG_PROGRESS_LIVE_PERSONAS), (logins) =>
    logins.split(",").map((login) => login.trim()),
  ),
  () => [],
);

const apiAs = (login: string) =>
  GitHubApi.layerFor(Option.some(login)).pipe(
    Layer.provide(GitHubTokens.layer),
    Layer.provide(Layer.mergeAll(Exec.layer, HostEnvironment.layer, FetchHttpClient.layer)),
    Layer.provide(BunServices.layer),
  );

const Ref = Schema.Struct({ ref: Schema.String });

// A prefix no other test uses, whose branches are deleted when the test ends.
const scratchPrefix = (slug: string, login: string) =>
  Effect.acquireRelease(
    Effect.sync(() => `chernabog/threads-live-${crypto.randomUUID().slice(0, 8)}/`),
    (prefix) =>
      Effect.gen(function* () {
        const refs = yield* githubGetAllPages(
          `/repos/${slug}/git/matching-refs/heads/${prefix}`,
          Schema.Array(Ref),
          (page) => page,
        );

        yield* Effect.forEach(refs, (found) =>
          githubRequest("DELETE", `/repos/${slug}/git/${found.ref}`),
        );
      }).pipe(Effect.provide(apiAs(login)), Effect.ignore),
  );

const adapter = (slug: string, login: string, prefix: string) =>
  makeThreadsProgress({ slug, persona: Option.some(login), prefix }).pipe(
    Effect.provide(apiAs(login)),
  );

const live = Option.all({
  slug: REPO,
  first: Option.fromUndefinedOr(PERSONAS[0]),
  second: Option.fromUndefinedOr(PERSONAS[1]),
});

if (Option.isSome(live)) {
  const { first, second, slug } = live.value;

  progressContract(
    `protected branches on ${slug}`,
    Effect.flatMap(scratchPrefix(slug, first), (prefix) => adapter(slug, first, prefix)),
  );

  const phase = Schema.decodeSync(Phase);
  const writer = Schema.decodeSync(PhaseWriter);
  const ASKED = phase("review-asked");

  const moves = (
    left: Progress["Service"],
    right: Progress["Service"],
    from: Option.Option<Phase>,
  ) =>
    Effect.all(
      [
        Effect.exit(left.advance("pr-1", { from, to: phase("changes-asked"), by: writer(first) })),
        Effect.exit(right.advance("pr-1", { from, to: phase("approved"), by: writer(second) })),
      ],
      { concurrency: "unbounded" },
    );

  describe(`two personas racing on ${slug}`, () => {
    effect(
      "of two first phases at once, one wins",
      () =>
        Effect.gen(function* () {
          const prefix = yield* scratchPrefix(slug, first);
          const left = yield* adapter(slug, first, prefix);
          const right = yield* adapter(slug, second, prefix);

          const exits = yield* moves(left, right, Option.none());

          expect(exits.filter(Exit.isSuccess).length).toBe(1);
          expect(Option.map(yield* left.read("pr-1"), (record) => record.by)).toEqual(
            Option.fromUndefinedOr(exits.find(Exit.isSuccess)?.value.by),
          );
        }),
      60_000,
    );

    effect(
      "of two advances from one phase at once, one wins, each time",
      () =>
        Effect.gen(function* () {
          for (let round = 0; round < 3; round += 1) {
            const prefix = yield* scratchPrefix(slug, first);
            const left = yield* adapter(slug, first, prefix);
            const right = yield* adapter(slug, second, prefix);
            yield* left.advance("pr-1", {
              from: Option.none(),
              to: ASKED,
              by: writer(first),
            });

            const exits = yield* moves(left, right, Option.some(ASKED));

            expect(exits.filter(Exit.isSuccess).length).toBe(1);
          }
        }),
      120_000,
    );
  });
} else {
  test.skip("on a real repo: set CHERNABOG_PROGRESS_LIVE_REPO and CHERNABOG_PROGRESS_LIVE_PERSONAS", () => {});
}
