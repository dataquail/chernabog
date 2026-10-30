import { Query } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { PersistenceFailed } from "../../../kernel/persistence.errors.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import {
  AmbiguousClone,
  CheckoutUnreadable,
  NoFlows,
} from "../domain/enrolled-repo/enrolled-repo.errors.ts";
import { MachineOffer } from "../domain/enrolled-repo/machine-offer.value-object.ts";

// A flow as enrolling offers it to a persona: whether the team has it on, why
// not, and why this machine can't run it, if it can't.
export const FlowOfferView = Schema.Struct({
  name: Schema.String,
  teamDefault: Schema.Boolean,
  teamOff: Schema.Option(Schema.String),
  unavailable: Schema.Option(Schema.String),
});

// What one persona of a repo can choose, and what it has now.
export const PersonaPlan = Schema.Struct({
  // The persona; none for the implicit one.
  persona: Schema.Option(Schema.String),
  offers: Schema.Array(FlowOfferView),
  // The flows it runs now, if the repo is enrolled.
  current: Schema.Option(Schema.Array(Schema.String)),
  // The flows it runs by default: the team's that it can run.
  defaults: Schema.Array(Schema.String),
  // Its account and other accounts now.
  account: Schema.Option(Schema.String),
  accounts: Schema.Array(Schema.String),
});

export type PersonaPlan = typeof PersonaPlan.Type;

// What enrolling a checkout can choose: the repo it's of, the machine's
// personas and the ones the repo has now, what each persona can run, and
// the accounts each agent can spend.
export class EnrollmentPlan extends Schema.Class<
  EnrollmentPlan,
  { readonly brand: "EnrollmentPlan" }
>("EnrollmentPlan")({
  repo: RepoSlug,
  root: Schema.String,
  logins: Schema.Array(Schema.String),
  currentPersonas: Schema.Option(Schema.Array(Schema.String)),
  personas: Schema.Array(PersonaPlan),
  accounts: Schema.Array(Schema.Struct({ name: Schema.String, agent: Schema.String })),
  // The repo's own agent, whose accounts a persona's own account is one of.
  teamAgent: Schema.Option(Schema.String),
  // The agents each flow runs.
  agentsByFlow: Schema.Record(Schema.String, Schema.Array(Schema.String)),
}) {}

// What enrolling the checkout a path is in can choose, for each persona the
// machine acts as: its flows, the defaults, and what it has now. `offered` is
// what machine setup reports the machine acts as and spends.
export const PlanEnrollmentQuery = Query.make("PlanEnrollmentQuery", {
  payload: {
    path: Schema.String,
    name: Schema.Option(Schema.String),
    offered: Schema.Struct(MachineOffer.fields),
  },
  success: EnrollmentPlan,
  failure: Schema.Union([CheckoutUnreadable, PersistenceFailed, NoFlows, AmbiguousClone]),
});

export type PlanEnrollmentPayload = Query.Payload<typeof PlanEnrollmentQuery>;
