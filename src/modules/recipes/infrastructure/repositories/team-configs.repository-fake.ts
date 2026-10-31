import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { pinnedValue } from "../../../../kernel/specification.ts";
import { TeamConfigRoot } from "../../domain/team-config/team-config.root.ts";
import { TeamConfigsRepository } from "../../domain/team-config/team-configs.repository.ts";

// A config that says nothing, as a checkout without the file has.
const silent = (root: string) =>
  TeamConfigRoot.make({
    root,
    agent: Option.none(),
    runners: Option.none(),
    reviewers: Option.none(),
    flows: {},
  });

// Teams' configs in memory. A checkout not among them has one that says
// nothing, as the live adapter reads a checkout without the file.
export const TeamConfigsRepositoryFake = (configs: ReadonlyArray<TeamConfigRoot>) =>
  Layer.succeed(
    TeamConfigsRepository,
    TeamConfigsRepository.of({
      findOne: (spec) =>
        Option.match(pinnedValue(spec.criteria, "root"), {
          onNone: () => Effect.die(new Error("a team's config is read by its checkout's root")),
          onSome: (root) =>
            Effect.succeed(
              Option.filter(
                Option.orElse(Arr.findFirst(configs, spec), () =>
                  Option.some(silent(String(root))),
                ),
                spec,
              ),
            ),
        }),
    }),
  );
