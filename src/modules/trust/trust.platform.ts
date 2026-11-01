// The platform surface: what the composition roots and the inbound adapters name to
// assemble and drive this module — its dispatchers, its Layers, and the results and
// value objects its messages answer with. It declares nothing; anything not
// re-exported here is private to the module.

export { type TrustOutcome } from "./commands/trust-repo.command.ts";
export { RepoTrusted } from "./domain/trust-record/trust-record.events.ts";
export { type TrustCheck } from "./queries/check-trust.query.ts";
export { trustCommandGroup, TrustCommands } from "./trust.command-handlers.ts";
export { TrustModule } from "./trust.module.ts";
export { TrustQueries } from "./trust.query-handlers.ts";
