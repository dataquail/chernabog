import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { IMPLICIT, type Persona } from "../../../kernel/persona.value-object.ts";
import { EnrolledRepoRootOps } from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { EnrolledRepoSpecifications } from "../domain/enrolled-repo/enrolled-repo.specification.ts";
import { EnrolledReposRepository } from "../domain/enrolled-repo/enrolled-repos.repository.ts";
import { MachineOffer } from "../domain/enrolled-repo/machine-offer.value-object.ts";
import { CheckoutsClient } from "../domain/ports/clients/checkouts.client.ts";
import { ViewerClient } from "../domain/ports/clients/viewer.client.ts";
import { EnrollmentPlan, type PlanEnrollmentPayload } from "./plan-enrollment.query.ts";

export const planEnrollmentHandler = Effect.fn("planEnrollmentHandler")(function* (
  query: PlanEnrollmentPayload,
) {
  const { name, path } = query;
  const machine = MachineOffer.make(query.offered);
  const checkouts = yield* CheckoutsClient;
  const checkout = yield* checkouts.inspect(yield* checkouts.rootOf(path));
  const repos = yield* (yield* EnrolledReposRepository).findMany(EnrolledRepoSpecifications.all);
  const existing = yield* Effect.fromResult(EnrolledRepoRootOps.entryOf(repos, checkout, name));
  const viewer = yield* ViewerClient;

  // Who the implicit persona is matters only to the team's runners, and only
  // without personas, so GitHub is asked only then.
  const implicit = yield* Option.match(
    Option.liftPredicate(IMPLICIT, () => machine.personas.length === 0),
    {
      onNone: () => Effect.succeed(Option.none<ReadonlyArray<string>>()),
      onSome: () => viewer.login.pipe(Effect.map((login) => Option.some(Option.toArray(login)))),
    },
  );

  const candidates = Option.match(implicit, {
    onSome: (): ReadonlyArray<Persona> => [IMPLICIT],
    onNone: () => machine.personas.map((login): Persona => Option.some(login)),
  });

  return EnrollmentPlan.make({
    repo: checkout.repo,
    root: checkout.root,
    logins: machine.personas,
    currentPersonas: EnrolledRepoRootOps.currentPersonas(existing),
    personas: candidates.map((persona) => {
      const logins = Option.match(persona, {
        onSome: (login) => [login],
        onNone: () => Option.getOrElse(implicit, (): ReadonlyArray<string> => []),
      });

      const offers = EnrolledRepoRootOps.flowOffers(checkout, machine, logins);
      const own = Option.map(existing, (found) => EnrolledRepoRootOps.choicesOf(found, persona));

      return {
        persona,
        offers,
        current: EnrolledRepoRootOps.currentFlows(existing, persona),
        defaults: EnrolledRepoRootOps.defaultFlows(offers),
        account: Option.flatMap(own, (found) => Option.fromUndefinedOr(found.account)),
        accounts: Option.getOrElse(
          Option.flatMap(own, (found) => Option.fromUndefinedOr(found.accounts)),
          (): ReadonlyArray<string> => [],
        ),
      };
    }),
    accounts: machine.accounts,
    teamAgent: checkout.team.agent,
    agentsByFlow: Object.fromEntries(
      checkout.flows.map((flow) => [flow, EnrolledRepoRootOps.agentsOf(checkout.team, flow)]),
    ),
  });
});
