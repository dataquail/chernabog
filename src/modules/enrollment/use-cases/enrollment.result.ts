import * as Schema from "effect/Schema";

import { RepoSlug } from "../../../kernel/repo-slug.id.ts";

export { type Offered } from "./enrolled-repos.result.ts";

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
  baseBranch: Schema.String,
  logins: Schema.Array(Schema.String),
  currentPersonas: Schema.Option(Schema.Array(Schema.String)),
  personas: Schema.Array(PersonaPlan),
  accounts: Schema.Array(Schema.Struct({ name: Schema.String, agent: Schema.String })),
  // The repo's own agent, whose accounts a persona's own account is one of.
  teamAgent: Schema.Option(Schema.String),
  // The agents each flow runs.
  agentsByFlow: Schema.Record(Schema.String, Schema.Array(Schema.String)),
}) {}

export const PersonaChoice = Schema.Struct({
  persona: Schema.Option(Schema.String),
  flows: Schema.Array(Schema.String),
  account: Schema.Option(Schema.String),
  accounts: Schema.Array(Schema.String),
});

// A persona that opens pull requests whose reviewers, the pool less it, are
// none of them a persona here, so its pull requests wait on another machine.
export const UnservedReviews = Schema.Struct({
  persona: Schema.Option(Schema.String),
  reviewers: Schema.Array(Schema.String),
});

// A repo as enrolling left it: whether its entry is new, what each persona
// runs and spends, and whose pull requests wait on reviewers not here.
export class Enrolled extends Schema.Class<Enrolled, { readonly brand: "Enrolled" }>("Enrolled")({
  added: Schema.Boolean,
  name: Schema.String,
  repo: RepoSlug,
  path: Schema.String,
  baseBranch: Schema.String,
  chosen: Schema.Array(PersonaChoice),
  unserved: Schema.Array(UnservedReviews),
}) {}

// The root of the checkout a path is in.
export class CheckoutRoot extends Schema.Class<CheckoutRoot, { readonly brand: "CheckoutRoot" }>(
  "CheckoutRoot",
)({
  root: Schema.String,
}) {}

// An entry whose checkout is gone: its name, the name it was given when it
// was given one, the repo it's of, and where its checkout was.
export class MovedRepo extends Schema.Class<MovedRepo, { readonly brand: "MovedRepo" }>(
  "MovedRepo",
)({
  name: Schema.String,
  named: Schema.Option(Schema.String),
  repo: RepoSlug,
  path: Schema.String,
}) {}

export class MovedRepos extends Schema.Class<MovedRepos, { readonly brand: "MovedRepos" }>(
  "MovedRepos",
)({
  repos: Schema.Array(MovedRepo),
}) {}
