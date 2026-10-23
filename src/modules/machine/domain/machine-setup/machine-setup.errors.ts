import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const listed = (items: ReadonlyArray<string>) =>
  Option.getOrElse(
    Option.liftPredicate(items.join(", "), (text) => text.length > 0),
    () => "none",
  );

// A persona chosen that gh isn't logged in as, so no token could be had for it.
export class NotLoggedIn extends Schema.TaggedError<
  NotLoggedIn,
  { readonly brand: "NotLoggedIn" }
>()("NotLoggedIn", { logins: Schema.Array(Schema.String), loggedIn: Schema.Array(Schema.String) }) {
  public override get message() {
    return `gh isn't logged in to github.com as ${this.logins.join(", ")} (it is as: ${listed(this.loggedIn)}); gh auth login as each first`;
  }
}

// Dropping these personas would strand the enrolled repos that run as them.
export class PersonaStillInUse extends Schema.TaggedError<
  PersonaStillInUse,
  { readonly brand: "PersonaStillInUse" }
>()("PersonaStillInUse", { logins: Schema.Array(Schema.String) }) {
  public override get message() {
    return `enrolled repos still run as ${this.logins.join(", ")}; keep those personas, or chernabog unenroll the repos first`;
  }
}

// An account directory whose agent its name doesn't tell, and nobody said.
export class AccountAgentUnknown extends Schema.TaggedError<
  AccountAgentUnknown,
  { readonly brand: "AccountAgentUnknown" }
>()("AccountAgentUnknown", { dir: Schema.String }) {
  public override get message() {
    return `can't tell which agent ${this.dir} belongs to; name it as ${this.dir}:<agent>, such as ${this.dir}:claude`;
  }
}

// An account directory that isn't there: the agent was never logged in with it.
export class AccountDirMissing extends Schema.TaggedError<
  AccountDirMissing,
  { readonly brand: "AccountDirMissing" }
>()("AccountDirMissing", { dir: Schema.String }) {
  public override get message() {
    return `${this.dir} doesn't exist; log in to the agent with it first`;
  }
}

// The service manager refused, or there's none to register the daemon with.
export class ServiceFailed extends Schema.TaggedError<
  ServiceFailed,
  { readonly brand: "ServiceFailed" }
>()("ServiceFailed", { message: Schema.String }) {}
