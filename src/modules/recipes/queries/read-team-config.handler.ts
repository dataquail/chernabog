import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { TeamConfigSpecifications } from "../domain/team-config/team-config.specification.ts";
import { TeamConfigsRepository } from "../domain/team-config/team-configs.repository.ts";
import { type ReadTeamConfigPayload, TeamConfig } from "./read-team-config.query.ts";

export const readTeamConfigHandler = Effect.fn("readTeamConfigHandler")(function* (
  query: ReadTeamConfigPayload,
) {
  const found = yield* (yield* TeamConfigsRepository).findOne(
    TeamConfigSpecifications.ofCheckout(query.root),
  );

  return Option.match(found, {
    onNone: () =>
      TeamConfig.make({
        agent: Option.none(),
        runners: Option.none(),
        reviewers: Option.none(),
        flows: {},
      }),
    onSome: ({ agent, flows, reviewers, runners }) =>
      TeamConfig.make({ agent, runners, reviewers, flows }),
  });
});
