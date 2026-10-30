import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import {
  AmbiguousClone,
  CheckoutUnreadable,
  FlowUnavailable,
  NoAccountForAgent,
  NoFlows,
  NoPersonaChosen,
  NoPersonasToChoose,
  PersonaChoiceNeeded,
  UnknownAccount,
  UnknownFlow,
  UnknownPersona,
} from "../domain/enrolled-repo/enrolled-repo.errors.ts";
import { MachineOffer } from "../domain/enrolled-repo/machine-offer.value-object.ts";

// How a person chose a persona's flows: the defaults, or these.
export const FlowsAnswer = Schema.Union([
  Schema.Struct({ defaults: Schema.Literal(true) }),
  Schema.Struct({ flows: Schema.Array(Schema.String) }),
]);

// What a person chose, as far as they did. An answer not given takes what the
// repo has now, else the default.
export const EnrollmentAnswers = Schema.Struct({
  // The personas that work in the repo; none is the machine's only one, else
  // the ones the repo has.
  personas: Schema.Option(Schema.Array(Schema.String)),
  // Flows for every persona, as flags give them.
  flows: Schema.Option(FlowsAnswer),
  // Accounts for every persona, by name, as flags give them.
  accounts: Schema.Array(Schema.String),
  // Each persona's own answers, as a person was asked them.
  asked: Schema.Array(
    Schema.Struct({
      persona: Schema.Option(Schema.String),
      flows: Schema.Option(Schema.Array(Schema.String)),
      accounts: Schema.Array(Schema.String),
    }),
  ),
});

export const PersonaChoice = Schema.Struct({
  persona: Schema.Option(Schema.String),
  flows: Schema.Array(Schema.String),
  account: Schema.Option(Schema.String),
  accounts: Schema.Array(Schema.String),
});

// A repo as enrolling left it: whether its entry is new, what each persona
// runs and spends.
export class Enrolled extends Schema.Class<Enrolled, { readonly brand: "Enrolled" }>("Enrolled")({
  added: Schema.Boolean,
  name: Schema.String,
  repo: RepoSlug,
  path: Schema.String,
  chosen: Schema.Array(PersonaChoice),
}) {}

// Enrolls the checkout a path is in, as a person chose: which personas work
// in it, which flows each runs, and which accounts each spends. One write,
// keeping every other setting the repo had. `offered` is what machine setup
// reports the machine acts as and spends.
export const ApplyEnrollmentCommand = Command.make("ApplyEnrollmentCommand", {
  payload: {
    path: Schema.String,
    name: Schema.Option(Schema.String),
    offered: Schema.Struct(MachineOffer.fields),
    answers: EnrollmentAnswers,
  },
  success: Enrolled,
  failure: Schema.Union([
    CheckoutUnreadable,
    PersistenceFailed,
    NoFlows,
    AmbiguousClone,
    NoPersonasToChoose,
    UnknownPersona,
    PersonaChoiceNeeded,
    NoPersonaChosen,
    UnknownFlow,
    FlowUnavailable,
    NoAccountForAgent,
    UnknownAccount,
  ]),
});

export type ApplyEnrollmentPayload = Command.Payload<typeof ApplyEnrollmentCommand>;
