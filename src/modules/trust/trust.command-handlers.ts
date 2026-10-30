import { Command } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { ClaimReloadCommand } from "./commands/claim-reload.command.ts";
import { claimReloadHandler } from "./commands/claim-reload.handler.ts";
import { TrustRepoCommand } from "./commands/trust-repo.command.ts";
import { trustRepoHandler } from "./commands/trust-repo.handler.ts";
import { TrustLayer } from "./trust.layer.ts";

export const trustCommandGroup = Command.group(ClaimReloadCommand, TrustRepoCommand);

const TrustCommandHandlersLive = Command.handlersOf(trustCommandGroup, {
  ClaimReloadCommand: (payload) => claimReloadHandler(payload),
  TrustRepoCommand: (payload) => trustRepoHandler(payload),
}).pipe(Layer.provide(TrustLayer));

// The trust module's slice of the write side, which the daemon and `trust`
// dispatch. TrustRepoCommand is a security gate: only the CLI's `trust`
// dispatches it, never an agent-facing adapter. It says RepoTrusted on the
// EventBus the composition root provides.
export class TrustCommands extends Context.Service<
  TrustCommands,
  Command.Dispatcher<typeof trustCommandGroup>
>()("TrustCommands") {}

export const TrustCommandsLive = Layer.effect(
  TrustCommands,
  Command.dispatcher(trustCommandGroup),
).pipe(Layer.provideMerge(TrustCommandHandlersLive));
