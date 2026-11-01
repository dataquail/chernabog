// The commands the daemon dispatches for its clients, on its own bus, through
// one route, POST /commands/:tag (docs/adr/0017-state-changing-commands-go-through-the-daemon.md).
// Each crosses the socket as its own CQRS message declares it: the payload,
// the success and the failure are the command's schemas, so no route or
// protocol type is written per command. A tag not listed here is refused.

import { Command } from "@effect-server-utils/cqrs";
import * as Arr from "effect/Array";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { enrollmentCommandGroup } from "../../modules/enrollment/enrollment.platform.ts";
import { trustCommandGroup } from "../../modules/trust/trust.platform.ts";

// Enrollment's commands a person runs from the CLI or the TUI: enrolling,
// unenrolling, pausing and resuming a repo, and a persona's settings. Not
// RepointRepoCommand, which only init's question about a moved checkout asks.
export const daemonEnrollmentCommands = Command.subsetOf(
  enrollmentCommandGroup,
  "ApplyEnrollmentCommand",
  "UnenrollRepoCommand",
  "PauseRepoCommand",
  "ResumeRepoCommand",
  "SetPersonaFlowCommand",
  "SetFlowScheduleCommand",
  "SetPersonaAccountCommand",
);

// Trusting a repo's .chernabog/, which only a person does. Not
// ClaimReloadCommand, the daemon's own bookkeeping.
export const daemonTrustCommands = Command.subsetOf(trustCommandGroup, "TrustRepoCommand");

const allowed: ReadonlyArray<Command.Any> = [
  ...daemonEnrollmentCommands.messages,
  ...daemonTrustCommands.messages,
];

// The tags the daemon dispatches, for a refusal to list.
export const daemonCommandTags = allowed.map((command) => command.tag);

// What each of the daemon's listeners may dispatch. The local socket, which
// only this machine's user reaches, dispatches every command above. The
// dashboard's TCP listener (dashboard.server.ts) dispatches a repo's pause and
// a persona's settings, and nothing else: enrolling and unenrolling name
// paths on disk, and trusting grants a repo's code the right to run, so they
// stay the CLI's and the TUI's.
export const DAEMON_COMMAND_LISTENERS = {
  socket: daemonCommandTags,
  tcp: [
    "PauseRepoCommand",
    "ResumeRepoCommand",
    "SetPersonaFlowCommand",
    "SetFlowScheduleCommand",
    "SetPersonaAccountCommand",
  ] satisfies ReadonlyArray<(typeof daemonEnrollmentCommands.messages)[number]["tag"]>,
} as const;

// The allowlisted command a tag names, if it is one.
export const daemonCommand = (tag: string): Option.Option<Command.Any> =>
  Arr.findFirst(allowed, (command) => command.tag === tag);

// A command's schemas as the socket carries them, both ways, typed as `M`,
// the command `command` is. A group keeps its messages' schemas erased, so each
// is rebuilt from its AST, which is all a schema decodes and encodes by.
// A CQRS message's schemas need no services: each module's serializable test
// checks they cross JSON.
export const wireSchemas = <M extends Command.Any>(command: Command.Any) => ({
  payload: Schema.make<Schema.Codec<Command.Payload<M>, unknown>>(command.schemas.payload.ast),
  success: Schema.make<Schema.Codec<Command.Success<M>, unknown>>(command.schemas.success.ast),
  failure: Schema.make<Schema.Codec<Command.Failure<M>, unknown>>(command.schemas.failure.ast),
});
