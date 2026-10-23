import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type Persona, samePersona } from "../../../kernel/persona.value-object.ts";
import { unservedReviewers } from "../../../kernel/reviewer-pool.value-object.ts";
import {
  EnrolledRepoRootOps,
  type PersonaEnrolment,
} from "../domain/enrolled-repo/enrolled-repo.root-ops.ts";
import { MachineOffer } from "../domain/enrolled-repo/machine-offer.value-object.ts";
import { CheckoutsClient } from "../domain/ports/clients/checkouts.client.ts";
import { ViewerClient } from "../domain/ports/clients/viewer.client.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { Enrolled, type Offered } from "./enrollment.result.ts";

// How a person chose a persona's flows: the defaults, or these.
export type FlowsAnswer = { readonly defaults: true } | { readonly flows: ReadonlyArray<string> };

// What a person chose, as far as they did. An answer not given takes what the
// repo has now, else the default.
export type EnrollmentAnswers = {
  // The personas that work in the repo; none is the machine's only one, else
  // the ones the repo has.
  readonly personas: Option.Option<ReadonlyArray<string>>;
  // Flows for every persona, as flags give them.
  readonly flows: Option.Option<FlowsAnswer>;
  // Accounts for every persona, by name, as flags give them.
  readonly accounts: ReadonlyArray<string>;
  // Each persona's own answers, as a person was asked them.
  readonly asked: ReadonlyArray<{
    readonly persona: Persona;
    readonly flows: Option.Option<ReadonlyArray<string>>;
    readonly accounts: ReadonlyArray<string>;
  }>;
};

// Enrolls the checkout a path is in, as a person chose: which personas work
// in it, which flows each runs, and which accounts each spends. One write,
// keeping every other setting the repo had.
export const applyEnrollmentUseCase = Effect.fn("applyEnrollmentUseCase")(function* (
  path: string,
  name: Option.Option<string>,
  offered: Offered,
  answers: EnrollmentAnswers,
) {
  const machine = MachineOffer.make(offered);
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
  const unserved: Array<{ persona: Persona; reviewers: ReadonlyArray<string> }> = [];

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

    // A persona that opens pull requests, whose reviewers no persona here serves.
    if (flows.some((flow) => (checkout.authoring ?? []).includes(flow))) {
      for (const reviewers of Option.toArray(
        unservedReviewers(checkout.team.reviewers ?? [], Arr.head(logins), machine.personas),
      )) {
        unserved.push({ persona, reviewers });
      }
    }
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
    baseBranch: EnrolledRepoRootOps.baseBranchOf(enrolled),
    chosen,
    unserved,
  });
});
