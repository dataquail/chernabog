import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { scratchRecipeRepos } from "../../../../test/recipe-repo.ts";
import { readTeamConfigHandler } from "./read-team-config.handler.ts";
import { TeamConfig } from "./read-team-config.query.ts";

const CONFIG = `# The team's config.
agent: claude
runners: [alice]
reviewers: [bob, carol]
launcher: tmux
flows:
  review:
    from: "@chernabog/recipes/review"
    agent: codex
    agents: { reviewer: codex }
  fix:
    enabled: false
    runners: [dave]
`;

const silent = TeamConfig.make({
  agent: Option.none(),
  runners: Option.none(),
  reviewers: Option.none(),
  flows: {},
});

describe("readTeamConfigHandler", () => {
  const repos = scratchRecipeRepos();

  effect("answers the team's agent, runners, reviewers and each flow's, leaving other keys", () =>
    Effect.gen(function* () {
      const root = yield* repos.checkout({ ".chernabog/config.yaml": CONFIG });

      expect(yield* readTeamConfigHandler({ root })).toEqual(
        TeamConfig.make({
          agent: Option.some("claude"),
          runners: Option.some(["alice"]),
          reviewers: Option.some(["bob", "carol"]),
          flows: {
            review: { agent: "codex", agents: { reviewer: "codex" } },
            fix: { enabled: false, runners: ["dave"] },
          },
        }),
      );
    }).pipe(Effect.provide(repos.layer)),
  );

  effect(
    "a checkout without a config.yaml, or with an empty one, has a team that says nothing",
    () =>
      Effect.gen(function* () {
        const absent = yield* repos.checkout({});
        const empty = yield* repos.checkout({ ".chernabog/config.yaml": "\n" });

        expect(yield* readTeamConfigHandler({ root: absent })).toEqual(silent);
        expect(yield* readTeamConfigHandler({ root: empty })).toEqual(silent);
      }).pipe(Effect.provide(repos.layer)),
  );

  effect("a file that doesn't parse, or names a flow's runners wrongly, fails naming it", () =>
    Effect.gen(function* () {
      for (const config of ["flows: [", "flows:\n  fix:\n    runners: dave\n"]) {
        const root = yield* repos.checkout({ ".chernabog/config.yaml": config });
        const error = yield* Effect.flip(readTeamConfigHandler({ root }));

        expect(error._tag).toBe("PersistenceFailed");
        expect(error.message).toContain(`${root}/.chernabog/config.yaml`);
      }
    }).pipe(Effect.provide(repos.layer)),
  );
});
