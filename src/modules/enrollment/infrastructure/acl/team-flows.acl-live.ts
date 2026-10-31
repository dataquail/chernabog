// The team's flows, asked of the recipes module, which owns the team's
// .chernabog/config.yaml: its published ReadTeamConfigQuery, translated into
// enrollment's TeamFlows. Its failure is a checkout enrolling can't read.

import { Query } from "@effect-server-utils/cqrs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CheckoutUnreadable } from "../../domain/enrolled-repo/enrolled-repo.errors.ts";
import { TeamFlows } from "../../domain/enrolled-repo/team-flows.value-object.ts";
import { TeamFlowsAcl } from "../../domain/ports/acl/team-flows.acl.ts";
import { recipesAccessQueries } from "../../enrollment.imports.ts";

export const TeamFlowsAclLive = Layer.effect(
  TeamFlowsAcl,
  Effect.gen(function* () {
    const recipes = yield* Query.dispatcher(recipesAccessQueries);

    const of = (root: string) =>
      recipes.ReadTeamConfigQuery({ root }).pipe(
        Effect.map((team) =>
          TeamFlows.make({
            agent: team.agent,
            runners: team.runners,
            ...Option.match(team.reviewers, {
              onNone: () => ({}),
              onSome: (reviewers) => ({ reviewers }),
            }),
            flows: team.flows,
          }),
        ),
        Effect.mapError((error) => new CheckoutUnreadable({ message: error.message })),
      );

    return TeamFlowsAcl.of({ of });
  }),
);
