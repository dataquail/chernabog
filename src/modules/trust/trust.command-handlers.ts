import { Command } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ownUnitOfWork } from "../../platform/unit-of-work.ts";
import { ClaimReloadCommand } from "./commands/claim-reload.command.ts";
import { claimReloadHandler } from "./commands/claim-reload.handler.ts";
import { TrustRepoCommand } from "./commands/trust-repo.command.ts";
import { trustRepoHandler } from "./commands/trust-repo.handler.ts";

export const trustCommandGroup = Command.group(ClaimReloadCommand, TrustRepoCommand);

const TrustCommandHandlersLive = Command.handlersOf(trustCommandGroup, {
  ClaimReloadCommand: (payload) => claimReloadHandler(payload),
  TrustRepoCommand: (payload) => trustRepoHandler(payload),
});

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
  Effect.flatMap(ownUnitOfWork, (own) =>
    Command.dispatcher(trustCommandGroup, { middleware: [own] }),
  ),
).pipe(Layer.provideMerge(TrustCommandHandlersLive));
