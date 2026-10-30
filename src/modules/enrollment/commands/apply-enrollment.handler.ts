import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { samePersona } from "../../../kernel/persona.value-object.ts";
import {
  EnrolledRepoRootOps,
  type PersonaEnrolment,
} from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { MachineOffer } from "../domain/enrolled-repo/machine-offer.value-object.ts";
import { CheckoutsClient } from "../domain/ports/clients/checkouts.client.ts";
import { ViewerClient } from "../domain/ports/clients/viewer.client.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { type ApplyEnrollmentPayload, Enrolled } from "./apply-enrollment.command.ts";

export const applyEnrollmentHandler = Effect.fn("applyEnrollmentHandler")(function* (
  cmd: ApplyEnrollmentPayload,
) {
  const { answers, name, path } = cmd;
  const machine = MachineOffer.make(cmd.offered);
  const viewer = yield* ViewerClient;
  const repository = yield* EnrolledReposRepository;
  const checkouts = yield* CheckoutsClient;
  const checkout = yield* checkouts.inspect(yield* checkouts.rootOf(path));
  const repos = yield* repository.findAll;
  const existing = yield* Effect.fromResult(EnrolledRepoRootOps.entryOf(repos, checkout, name));

  const personas = yield* Effect.fromResult(
    EnrolledRepoRootOps.choosePersonas(
      machine,
      EnrolledRepoRootOps.currentPersonas(existing),
      answers.personas,
    ),
  );

  // Who the implicit persona is matters only to the team's runners.
  const implicit = yield* Option.match(
    Arr.findFirst(personas, (persona) => Option.isNone(persona)),
    {
      onNone: () => Effect.succeed<ReadonlyArray<string>>([]),
      onSome: () => viewer.login.pipe(Effect.map((login) => Option.toArray(login))),
    },
  );

  const chosen: Array<PersonaEnrolment> = [];

  for (const persona of personas) {
    const asked = Arr.findFirst(answers.asked, (answer) => samePersona(answer.persona, persona));
    const logins = Option.getOrElse(Option.map(persona, Arr.of), () => implicit);
    const offers = EnrolledRepoRootOps.flowOffers(checkout, machine, logins);
    const own = Option.map(existing, (found) => EnrolledRepoRootOps.choicesOf(found, persona));

    const answered = Option.orElse(
      Option.flatMap(asked, (answer) => answer.flows),
      () =>
        Option.map(answers.flows, (given) => {
          if ("defaults" in given) {
            return EnrolledRepoRootOps.defaultFlows(offers);
          }

          return given.flows;
        }),
    );

    const flows = yield* Effect.fromResult(
      EnrolledRepoRootOps.chooseFlows(
        offers,
        EnrolledRepoRootOps.currentFlows(existing, persona),
        answered,
      ),
    );

    const accounts = yield* Effect.fromResult(
      EnrolledRepoRootOps.chooseAccounts(
        machine,
        checkout.team,
        flows,
        {
          account: Option.flatMap(own, (found) => Option.fromUndefinedOr(found.account)),
          accounts: Option.getOrElse(
            Option.flatMap(own, (found) => Option.fromUndefinedOr(found.accounts)),
            (): ReadonlyArray<string> => [],
          ),
        },
        [
          ...Option.getOrElse(
            Option.map(asked, (answer) => answer.accounts),
            () => [],
          ),
          ...answers.accounts,
        ],
      ),
    );

    chosen.push({ persona, flows, ...accounts });
  }

  const { added, repo } = yield* Effect.fromResult(
    EnrolledRepoRootOps.enroll(repos, checkout, name),
  );

  // Several personas each keep their own choices; one runs from the repo's entry.
  const perPersona =
    machine.personas.length > 1 ||
    Option.exists(existing, (found) => Option.isSome(Option.fromUndefinedOr(found.personas)));

  const enrolled = EnrolledRepoRootOps.enrolPersonas(repo, chosen, perPersona);
  yield* repository.save(enrolled);

  return Enrolled.make({
    added,
    name: EnrolledRepoRootOps.nameOf(enrolled),
    repo: enrolled.repo,
    path: enrolled.path,
    chosen,
  });
});
