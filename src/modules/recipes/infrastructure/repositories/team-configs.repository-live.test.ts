import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { TeamConfigRoot } from "../../domain/team-config/team-config.root.ts";
import { TeamConfigSpecifications } from "../../domain/team-config/team-config.specification.ts";
import { TeamConfigsRepository } from "../../domain/team-config/team-configs.repository.ts";
import { TeamConfigsRepositoryLive } from "./team-configs.repository-live.ts";

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

// A checkout holding `config` as its .chernabog/config.yaml, or none.
const checkout = (config: Option.Option<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-team-" });
    yield* fs.makeDirectory(`${root}/.chernabog`);

    if (Option.isSome(config)) {
      yield* fs.writeFileString(`${root}/.chernabog/config.yaml`, config.value);
    }

    return root;
  });

describe("TeamConfigsRepositoryLive", () => {
  effect("reads the team's agent, runners, reviewers and each flow's, leaving other keys", () =>
    Effect.gen(function* () {
      const root = yield* checkout(Option.some(CONFIG));

      const found = yield* (yield* TeamConfigsRepository).findOne(
        TeamConfigSpecifications.ofCheckout(root),
      );

      expect(found).toEqual(
        Option.some(
          TeamConfigRoot.make({
            root,
            agent: Option.some("claude"),
            runners: Option.some(["alice"]),
            reviewers: Option.some(["bob", "carol"]),
            flows: {
              review: { agent: "codex", agents: { reviewer: "codex" } },
              fix: { enabled: false, runners: ["dave"] },
            },
          }),
        ),
      );
    }).pipe(Effect.provide(TeamConfigsRepositoryLive)),
  );

  effect("a checkout without the file, or with an empty one, has a config that says nothing", () =>
    Effect.gen(function* () {
      const repository = yield* TeamConfigsRepository;

      for (const config of [Option.none(), Option.some("\n")]) {
        const root = yield* checkout(config);
        const found = yield* repository.findOne(TeamConfigSpecifications.ofCheckout(root));

        expect(found).toEqual(
          Option.some(
            TeamConfigRoot.make({
              root,
              agent: Option.none(),
              runners: Option.none(),
              reviewers: Option.none(),
              flows: {},
            }),
          ),
        );
      }
    }).pipe(Effect.provide(TeamConfigsRepositoryLive)),
  );

  effect("a file that doesn't parse, or names a flow's runners wrongly, fails naming it", () =>
    Effect.gen(function* () {
      const repository = yield* TeamConfigsRepository;

      for (const config of ["flows: [", "flows:\n  fix:\n    runners: dave\n"]) {
        const root = yield* checkout(Option.some(config));

        const error = yield* Effect.flip(
          repository.findOne(TeamConfigSpecifications.ofCheckout(root)),
        );

        expect(error._tag).toBe("PersistenceFailed");
        expect(error.message).toContain(`${root}/.chernabog/config.yaml`);
      }
    }).pipe(Effect.provide(TeamConfigsRepositoryLive)),
  );
});
