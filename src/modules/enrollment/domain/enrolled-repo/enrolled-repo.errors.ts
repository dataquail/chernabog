import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RepoSlug } from "../../../../kernel/repo-slug.id.ts";

// Several clones of one repo are enrolled, and nothing says which one is meant.
export class AmbiguousClone extends Schema.TaggedError<
  AmbiguousClone,
  { readonly brand: "AmbiguousClone" }
>()("AmbiguousClone", {
  repo: RepoSlug,
  names: Schema.Array(Schema.String),
}) {
  public override get message() {
    return `${this.repo} is enrolled as ${this.names.join(", ")}; name the one this is with --name`;
  }
}

// No enrolled repo answers to the name a person gave.
export class RepoNotEnrolled extends Schema.TaggedError<
  RepoNotEnrolled,
  { readonly brand: "RepoNotEnrolled" }
>()("RepoNotEnrolled", {
  asked: Schema.String,
  enrolled: Schema.Array(Schema.String),
}) {
  public override get message() {
    const known = Option.getOrElse(
      Option.liftPredicate(this.enrolled.join(", "), (names) => names.length > 0),
      () => "none",
    );

    return `no enrolled repo named ${this.asked} (enrolled: ${known}); run chernabog enroll in it`;
  }
}

const listed = (items: ReadonlyArray<string>) =>
  Option.getOrElse(
    Option.liftPredicate(items.join(", "), (text) => text.length > 0),
    () => "none",
  );

// A checkout that can't be enrolled as it is: not a git repo, an origin that
// isn't on GitHub, or a .chernabog/ that doesn't read.
export class CheckoutUnreadable extends Schema.TaggedError<
  CheckoutUnreadable,
  { readonly brand: "CheckoutUnreadable" }
>()("CheckoutUnreadable", { message: Schema.String }) {}

// Enrolling chooses among a checkout's flows, so one without any waits for one.
export class NoFlows extends Schema.TaggedError<NoFlows, { readonly brand: "NoFlows" }>()(
  "NoFlows",
  { root: Schema.String },
) {
  public override get message() {
    return `${this.root}: no flows in .chernabog/flows/; run chernabog init here first`;
  }
}

// Personas were named, but machine config acts as no GitHub persona.
export class NoPersonasToChoose extends Schema.TaggedError<
  NoPersonasToChoose,
  { readonly brand: "NoPersonasToChoose" }
>()("NoPersonasToChoose", {}) {
  public override get message() {
    return "machine config lists no GitHub personas to choose from; add them with chernabog setup";
  }
}

// Machine config acts as several personas, and nothing says which work here.
export class PersonaChoiceNeeded extends Schema.TaggedError<
  PersonaChoiceNeeded,
  { readonly brand: "PersonaChoiceNeeded" }
>()("PersonaChoiceNeeded", { logins: Schema.Array(Schema.String) }) {
  public override get message() {
    return `machine config has several GitHub personas (${this.logins.join(", ")}); choose this repo's with --persona`;
  }
}

// Personas named that machine config doesn't act as.
export class UnknownPersona extends Schema.TaggedError<
  UnknownPersona,
  { readonly brand: "UnknownPersona" }
>()("UnknownPersona", { logins: Schema.Array(Schema.String), known: Schema.Array(Schema.String) }) {
  public override get message() {
    return `${this.logins.join(", ")} isn't one of machine config's GitHub personas (${this.known.join(", ")}); add it with chernabog setup`;
  }
}

export class NoPersonaChosen extends Schema.TaggedError<
  NoPersonaChosen,
  { readonly brand: "NoPersonaChosen" }
>()("NoPersonaChosen", {}) {
  public override get message() {
    return "choose at least one GitHub persona for the repo";
  }
}

// A flow named that the checkout doesn't have.
export class UnknownFlow extends Schema.TaggedError<
  UnknownFlow,
  { readonly brand: "UnknownFlow" }
>()("UnknownFlow", { flow: Schema.String, known: Schema.Array(Schema.String) }) {
  public override get message() {
    return `no flow named ${this.flow} in .chernabog/flows/ (it has: ${listed(this.known)})`;
  }
}

// A flow named that this machine can't run, and why.
export class FlowUnavailable extends Schema.TaggedError<
  FlowUnavailable,
  { readonly brand: "FlowUnavailable" }
>()("FlowUnavailable", { flow: Schema.String, reason: Schema.String }) {
  public override get message() {
    return `${this.flow} can't run here: it ${this.reason}`;
  }
}

// Nothing in machine config can spend for the agent the repo runs.
export class NoAccountForAgent extends Schema.TaggedError<
  NoAccountForAgent,
  { readonly brand: "NoAccountForAgent" }
>()("NoAccountForAgent", { agent: Schema.Option(Schema.String) }) {
  public override get message() {
    return `no account for ${Option.getOrElse(this.agent, () => "any agent")} in machine config; add one with chernabog setup`;
  }
}

// Accounts named that machine config doesn't have.
export class UnknownAccount extends Schema.TaggedError<
  UnknownAccount,
  { readonly brand: "UnknownAccount" }
>()("UnknownAccount", { names: Schema.Array(Schema.String), known: Schema.Array(Schema.String) }) {
  public override get message() {
    return `no account named ${this.names.join(", ")} in machine config (it has: ${listed(this.known)})`;
  }
}

// A persona's accounts that would fail its runs: one machine config doesn't
// have, or two on one agent.
export class AccountsClash extends Schema.TaggedError<
  AccountsClash,
  { readonly brand: "AccountsClash" }
>()("AccountsClash", { message: Schema.String }) {}

// A schedule that isn't a cron expression.
export class InvalidSchedule extends Schema.TaggedError<
  InvalidSchedule,
  { readonly brand: "InvalidSchedule" }
>()("InvalidSchedule", { message: Schema.String }) {}
