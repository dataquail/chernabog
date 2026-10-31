import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import { TeamFlows } from "../../domain/enrolled-repo/team-flows.value-object.ts";
import { TeamFlowsAcl } from "../../domain/ports/acl/team-flows.acl.ts";

// What each team says, by checkout root. A checkout not among them has a team
// that says nothing, as one without a config.yaml does.
export const TeamFlowsAclFake = (teams: Readonly<Record<string, TeamFlows>>) =>
  Layer.succeed(
    TeamFlowsAcl,
    TeamFlowsAcl.of({
      of: (root) =>
        Effect.succeed(
          Option.getOrElse(Record.get(teams, root), () =>
            TeamFlows.make({ agent: Option.none(), runners: Option.none(), flows: {} }),
          ),
        ),
    }),
  );
