import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { scratchRecipeRepos } from "../../../../test/recipe-repo.ts";
import { readTeamConfigHandler } from "./read-team-config.handler.ts";
import { TeamConfig } from "./read-team-config.query.ts";

describe("readTeamConfigHandler", () => {
  const repos = scratchRecipeRepos();

  effect("answers what the checkout's config.yaml says of who runs its flows", () =>
    Effect.gen(function* () {
      const root = yield* repos.checkout({
        ".chernabog/config.yaml":
          "agent: claude\nreviewers: [bob]\nflows:\n  review:\n    agent: codex\n    runners: [bob]\n",
      });

      const team = yield* readTeamConfigHandler({ root });

      expect(team).toEqual(
        TeamConfig.make({
          agent: Option.some("claude"),
          runners: Option.none(),
          reviewers: Option.some(["bob"]),
          flows: { review: { agent: "codex", runners: ["bob"] } },
        }),
      );
    }).pipe(Effect.provide(repos.layer)),
  );

  effect("a checkout without a config.yaml has a team that says nothing", () =>
    Effect.gen(function* () {
      const root = yield* repos.checkout({});
      const team = yield* readTeamConfigHandler({ root });

      expect(team).toEqual(
        TeamConfig.make({
          agent: Option.none(),
          runners: Option.none(),
          reviewers: Option.none(),
          flows: {},
        }),
      );
    }).pipe(Effect.provide(repos.layer)),
  );
});
